# Slack Daily Digest

Automated daily summary of your Slack activity, delivered Mon-Thurs at 4pm.

## What's Included in the Digest

- **Mentions**: Messages where you were @mentioned
- **Direct Messages**: New DMs received
- **Active Channels**: Channels with the most activity
- **Thread Participation**: Threads you're involved in

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click "Create New App" > "From scratch"
3. Add these Bot Token Scopes under OAuth & Permissions:
   - `channels:history`
   - `channels:read`
   - `groups:history`
   - `groups:read`
   - `im:history`
   - `im:read`
   - `mpim:history`
   - `mpim:read`
   - `users:read`
   - `chat:write` (for sending DM digests)
4. Install to your workspace
5. Copy the Bot User OAuth Token

### 2. Find Your User ID

1. Open Slack
2. Click your profile picture
3. Click "Profile"
4. Click the "..." menu
5. Select "Copy member ID"

### 3. Configure Environment

Copy `.env.example` to `.env` and fill in:

```bash
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_USER_ID=U12345678
SEND_DM=true
```

### 4. Schedule (Choose One)

**Option A: GitHub Actions (Recommended)**

1. Go to your repo Settings > Secrets and variables > Actions
2. Add secrets:
   - `SLACK_BOT_TOKEN`: Your bot token
   - `SLACK_USER_ID`: Your user ID
3. The workflow runs automatically Mon-Thurs at 4pm

**Option B: Cron (Self-hosted)**

```bash
# Install dependencies
pip install -r requirements.txt

# Add to crontab
crontab -e
# Add: 0 16 * * 1-4 cd /path/to/slack_digest && python3 digest.py
```

## Manual Run

```bash
cd slack_digest
pip install -r requirements.txt
export SLACK_BOT_TOKEN=xoxb-...
export SLACK_USER_ID=U...
python digest.py
```

## Output

The digest prints to stdout by default. Set `SEND_DM=true` to receive it as a Slack DM, or set `OUTPUT_FILE=digest.json` to save as JSON.
