#!/usr/bin/env python3
"""
Slack Daily Digest - Generates a summary of Slack activity.
Designed to run Mon-Thurs at 4pm via scheduler.
"""

import os
import json
from datetime import datetime, timedelta
from collections import defaultdict
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

SLACK_TOKEN = os.environ.get("SLACK_BOT_TOKEN")
SLACK_USER_ID = os.environ.get("SLACK_USER_ID")


def get_client():
    if not SLACK_TOKEN:
        raise ValueError("SLACK_BOT_TOKEN environment variable not set")
    return WebClient(token=SLACK_TOKEN)


def get_channels(client):
    """Get all channels the bot has access to."""
    channels = []
    cursor = None
    while True:
        response = client.conversations_list(
            types="public_channel,private_channel,mpim,im",
            limit=200,
            cursor=cursor
        )
        channels.extend(response["channels"])
        cursor = response.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            break
    return channels


def get_messages_since(client, channel_id, since_ts):
    """Get messages from a channel since a given timestamp."""
    messages = []
    try:
        response = client.conversations_history(
            channel=channel_id,
            oldest=str(since_ts),
            limit=100
        )
        messages = response.get("messages", [])
    except SlackApiError as e:
        if e.response["error"] != "channel_not_found":
            print(f"Error fetching channel {channel_id}: {e}")
    return messages


def get_thread_replies(client, channel_id, thread_ts):
    """Get replies in a thread."""
    try:
        response = client.conversations_replies(
            channel=channel_id,
            ts=thread_ts,
            limit=50
        )
        return response.get("messages", [])[1:]  # Exclude parent message
    except SlackApiError:
        return []


def is_mention_of_user(message, user_id):
    """Check if message mentions the user."""
    text = message.get("text", "")
    return f"<@{user_id}>" in text


def categorize_messages(messages, user_id):
    """Categorize messages into relevant buckets."""
    categories = {
        "mentions": [],
        "direct_messages": [],
        "threads_participated": [],
        "high_activity": [],
    }

    for msg in messages:
        if is_mention_of_user(msg, user_id):
            categories["mentions"].append(msg)
        if msg.get("user") == user_id:
            categories["threads_participated"].append(msg)

    return categories


def generate_digest(client, user_id=None):
    """Generate a digest of Slack activity for the past day."""
    user_id = user_id or SLACK_USER_ID
    if not user_id:
        raise ValueError("SLACK_USER_ID environment variable not set")

    since = datetime.now() - timedelta(days=1)
    since_ts = since.timestamp()

    channels = get_channels(client)
    digest = {
        "generated_at": datetime.now().isoformat(),
        "period": f"Last 24 hours (since {since.strftime('%Y-%m-%d %H:%M')})",
        "channels_scanned": len(channels),
        "summary": {
            "total_messages": 0,
            "mentions": [],
            "direct_messages": [],
            "active_channels": [],
            "threads_with_replies": [],
        }
    }

    channel_activity = defaultdict(int)

    for channel in channels:
        channel_id = channel["id"]
        channel_name = channel.get("name", "DM")
        is_dm = channel.get("is_im", False) or channel.get("is_mpim", False)

        messages = get_messages_since(client, channel_id, since_ts)
        if not messages:
            continue

        channel_activity[channel_name] = len(messages)
        digest["summary"]["total_messages"] += len(messages)

        for msg in messages:
            if is_mention_of_user(msg, user_id):
                digest["summary"]["mentions"].append({
                    "channel": channel_name,
                    "text": msg.get("text", "")[:200],
                    "user": msg.get("user"),
                    "ts": msg.get("ts"),
                })

            if is_dm and msg.get("user") != user_id:
                digest["summary"]["direct_messages"].append({
                    "from": msg.get("user"),
                    "text": msg.get("text", "")[:200],
                    "ts": msg.get("ts"),
                })

            if msg.get("reply_count", 0) > 0:
                replies = get_thread_replies(client, channel_id, msg["ts"])
                user_replied = any(r.get("user") == user_id for r in replies)
                if user_replied or is_mention_of_user(msg, user_id):
                    digest["summary"]["threads_with_replies"].append({
                        "channel": channel_name,
                        "parent_text": msg.get("text", "")[:100],
                        "reply_count": msg.get("reply_count", 0),
                    })

    sorted_channels = sorted(channel_activity.items(), key=lambda x: x[1], reverse=True)
    digest["summary"]["active_channels"] = [
        {"name": name, "message_count": count}
        for name, count in sorted_channels[:10]
    ]

    return digest


def format_digest_text(digest):
    """Format digest as readable text."""
    lines = [
        "=" * 50,
        f"SLACK DAILY DIGEST - {datetime.now().strftime('%A, %B %d, %Y')}",
        "=" * 50,
        "",
        f"Period: {digest['period']}",
        f"Channels scanned: {digest['channels_scanned']}",
        f"Total messages: {digest['summary']['total_messages']}",
        "",
    ]

    if digest["summary"]["mentions"]:
        lines.append("MENTIONS (@you):")
        lines.append("-" * 30)
        for m in digest["summary"]["mentions"][:10]:
            lines.append(f"  #{m['channel']}: {m['text'][:80]}...")
        lines.append("")

    if digest["summary"]["direct_messages"]:
        lines.append("DIRECT MESSAGES:")
        lines.append("-" * 30)
        for dm in digest["summary"]["direct_messages"][:10]:
            lines.append(f"  From {dm['from']}: {dm['text'][:80]}...")
        lines.append("")

    if digest["summary"]["active_channels"]:
        lines.append("MOST ACTIVE CHANNELS:")
        lines.append("-" * 30)
        for ch in digest["summary"]["active_channels"][:5]:
            lines.append(f"  #{ch['name']}: {ch['message_count']} messages")
        lines.append("")

    if digest["summary"]["threads_with_replies"]:
        lines.append("THREADS WITH YOUR PARTICIPATION:")
        lines.append("-" * 30)
        for t in digest["summary"]["threads_with_replies"][:5]:
            lines.append(f"  #{t['channel']}: {t['parent_text'][:60]}... ({t['reply_count']} replies)")
        lines.append("")

    lines.append("=" * 50)
    return "\n".join(lines)


def send_digest_to_user(client, user_id, digest_text):
    """Send the digest as a DM to the user."""
    try:
        response = client.conversations_open(users=[user_id])
        channel_id = response["channel"]["id"]
        client.chat_postMessage(channel=channel_id, text=digest_text)
        print(f"Digest sent to user {user_id}")
    except SlackApiError as e:
        print(f"Error sending digest: {e}")


def main():
    client = get_client()
    user_id = SLACK_USER_ID

    print(f"Generating digest for user {user_id}...")
    digest = generate_digest(client, user_id)
    digest_text = format_digest_text(digest)

    print(digest_text)

    if os.environ.get("SEND_DM", "false").lower() == "true":
        send_digest_to_user(client, user_id, digest_text)

    output_file = os.environ.get("OUTPUT_FILE")
    if output_file:
        with open(output_file, "w") as f:
            json.dump(digest, f, indent=2)
        print(f"Digest saved to {output_file}")


if __name__ == "__main__":
    main()
