#include "PluginProcessor.h"
#include "PluginEditor.h"

namespace drumpad
{
    juce::String padParamId (const char* name, int pad)
    {
        return "pad" + juce::String (pad + 1) + "_" + name;
    }

    juce::String noteName (int note)
    {
        // Octave 3 for middle C matches Pro Tools, so note 36 reads as C1.
        return juce::MidiMessage::getMidiNoteName (note, true, true, 3);
    }
}

using namespace drumpad;

//==============================================================================
DrumPadProcessor::DrumPadProcessor()
    : AudioProcessor (BusesProperties().withOutput ("Output", juce::AudioChannelSet::stereo(), true)),
      parameters (*this, nullptr, "CurateDrumPad", createParameterLayout())
{
    formatManager.registerBasicFormats();

    for (int i = 0; i < numPads; ++i)
    {
        padParams[(size_t) i].volumeDb = parameters.getRawParameterValue (padParamId ("volume", i));
        padParams[(size_t) i].pan      = parameters.getRawParameterValue (padParamId ("pan", i));
        padParams[(size_t) i].tune     = parameters.getRawParameterValue (padParamId ("tune", i));
    }

    masterVolumeDb = parameters.getRawParameterValue ("master");

    for (auto& a : pendingAuditions)
        a = 0.0f;

    resetNoteMapToDefault();
    browserFolder = findSpliceFolder();

    startTimer (2000);
}

DrumPadProcessor::~DrumPadProcessor()
{
    stopTimer();
}

juce::AudioProcessorValueTreeState::ParameterLayout DrumPadProcessor::createParameterLayout()
{
    juce::AudioProcessorValueTreeState::ParameterLayout layout;

    layout.add (std::make_unique<juce::AudioParameterFloat> (
        juce::ParameterID { "master", 1 }, "Master Volume",
        juce::NormalisableRange<float> (-60.0f, 6.0f, 0.1f), 0.0f,
        juce::AudioParameterFloatAttributes().withLabel ("dB")));

    for (int i = 0; i < numPads; ++i)
    {
        auto prefix = "Pad " + juce::String (i + 1) + " ";

        layout.add (std::make_unique<juce::AudioParameterFloat> (
            juce::ParameterID { padParamId ("volume", i), 1 }, prefix + "Volume",
            juce::NormalisableRange<float> (-60.0f, 12.0f, 0.1f), 0.0f,
            juce::AudioParameterFloatAttributes().withLabel ("dB")));

        layout.add (std::make_unique<juce::AudioParameterFloat> (
            juce::ParameterID { padParamId ("pan", i), 1 }, prefix + "Pan",
            juce::NormalisableRange<float> (-1.0f, 1.0f, 0.01f), 0.0f));

        layout.add (std::make_unique<juce::AudioParameterFloat> (
            juce::ParameterID { padParamId ("tune", i), 1 }, prefix + "Tune",
            juce::NormalisableRange<float> (-24.0f, 24.0f, 0.01f), 0.0f,
            juce::AudioParameterFloatAttributes().withLabel ("st")));
    }

    return layout;
}

//==============================================================================
void DrumPadProcessor::prepareToPlay (double sampleRate, int)
{
    currentSampleRate = sampleRate > 0.0 ? sampleRate : 44100.0;

    for (auto& v : voices)
        v.sample = nullptr;
}

bool DrumPadProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    auto out = layouts.getMainOutputChannelSet();
    return out == juce::AudioChannelSet::stereo() || out == juce::AudioChannelSet::mono();
}

void DrumPadProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    buffer.clear();

    // Pick up sample swaps made on the message thread. If the lock is busy we
    // simply keep using last block's samples.
    {
        const juce::SpinLock::ScopedTryLockType lock (sampleLock);

        if (lock.isLocked())
            for (int i = 0; i < numSlots; ++i)
                if (audioThreadSamples[(size_t) i] != pads[(size_t) i].sample)
                    audioThreadSamples[(size_t) i] = pads[(size_t) i].sample;
    }

    for (int i = 0; i < numSlots; ++i)
    {
        auto velocity = pendingAuditions[(size_t) i].exchange (0.0f);

        if (velocity > 0.0f)
            triggerSlot (i, -1, velocity);
    }

    const int numSamples = buffer.getNumSamples();
    int position = 0;

    for (const auto metadata : midi)
    {
        const int eventPos = juce::jlimit (0, numSamples, metadata.samplePosition);

        if (eventPos > position)
        {
            renderVoices (buffer, position, eventPos - position);
            position = eventPos;
        }

        handleMidi (metadata.getMessage());
    }

    if (position < numSamples)
        renderVoices (buffer, position, numSamples - position);

    buffer.applyGain (juce::Decibels::decibelsToGain (masterVolumeDb->load(), -60.0f));
    midi.clear();
}

void DrumPadProcessor::handleMidi (const juce::MidiMessage& message)
{
    if (message.isNoteOn())
    {
        const int note = message.getNoteNumber();
        lastNoteReceived = note;

        const int learnPad = learningPad.load();

        if (learnPad >= 0 && learnPad < numPads)
        {
            pads[(size_t) learnPad].note = note;

            if (learningAll.load() && learnPad + 1 < numPads)
                learningPad = learnPad + 1;
            else
                cancelMidiLearn();

            // While learning, only play the pad that just got assigned.
            triggerSlot (learnPad, note, message.getFloatVelocity());
            return;
        }

        for (int i = 0; i < numPads; ++i)
            if (pads[(size_t) i].note.load() == note)
                triggerSlot (i, note, message.getFloatVelocity());
    }
    else if (message.isNoteOff())
    {
        releaseNote (message.getNoteNumber());
    }
    else if (message.isAllNotesOff() || message.isAllSoundOff())
    {
        for (auto& v : voices)
            if (v.isActive())
                startFade (v, 0.005);
    }
}

void DrumPadProcessor::triggerSlot (int slot, int note, float velocity)
{
    auto sample = audioThreadSamples[(size_t) slot];

    if (sample == nullptr || sample->buffer.getNumSamples() == 0)
        return;

    auto& pad = pads[(size_t) slot];
    pad.triggerCount.fetch_add (1);

    // Choke groups: a hit on this pad quickly fades out other pads in the same
    // group (for example an open hi hat cut by a closed hi hat).
    if (slot < numPads)
    {
        const int group = pad.chokeGroup.load();

        if (group > 0)
            for (auto& v : voices)
                if (v.isActive() && v.pad != slot && v.pad < numPads
                     && pads[(size_t) v.pad].chokeGroup.load() == group)
                    startFade (v, 0.008);
    }
    else
    {
        // Only one browser preview at a time.
        for (auto& v : voices)
            if (v.isActive() && v.pad == previewSlot)
                startFade (v, 0.005);
    }

    // Find a free voice, otherwise steal the oldest one.
    Voice* target = nullptr;

    for (auto& v : voices)
    {
        if (! v.isActive())
        {
            target = &v;
            break;
        }

        if (target == nullptr || v.age < target->age)
            target = &v;
    }

    const float tune = slot < numPads ? padParams[(size_t) slot].tune->load() : 0.0f;

    target->sample = sample;
    target->pad = slot;
    target->note = note;
    target->position = 0.0;
    target->increment = (sample->sampleRate / currentSampleRate) * std::pow (2.0, (double) tune / 12.0);
    target->velocityGain = slot < numPads ? velocity : 0.8f;
    target->fadeRemaining = -1;
    target->age = ++voiceAgeCounter;
}

void DrumPadProcessor::releaseNote (int note)
{
    for (auto& v : voices)
        if (v.isActive() && v.note == note && v.pad < numPads
             && ! pads[(size_t) v.pad].oneShot.load() && v.fadeRemaining < 0)
            startFade (v, 0.02);
}

void DrumPadProcessor::startFade (Voice& voice, double seconds)
{
    const int length = juce::jmax (1, (int) (seconds * currentSampleRate));

    if (voice.fadeRemaining < 0 || voice.fadeRemaining > length)
    {
        voice.fadeLength = length;
        voice.fadeRemaining = length;
    }
}

void DrumPadProcessor::renderVoices (juce::AudioBuffer<float>& buffer, int start, int numSamples)
{
    const int numOutChannels = buffer.getNumChannels();

    if (numOutChannels == 0)
        return;

    auto* outL = buffer.getWritePointer (0, start);
    auto* outR = numOutChannels > 1 ? buffer.getWritePointer (1, start) : nullptr;

    for (auto& v : voices)
    {
        if (! v.isActive())
            continue;

        const auto& data = v.sample->buffer;
        const int length = data.getNumSamples();
        const float* srcL = data.getReadPointer (0);
        const float* srcR = data.getNumChannels() > 1 ? data.getReadPointer (1) : srcL;

        float gain = v.velocityGain;
        float pan = 0.0f;

        if (v.pad < numPads)
        {
            gain *= juce::Decibels::decibelsToGain (padParams[(size_t) v.pad].volumeDb->load(), -60.0f);
            pan = padParams[(size_t) v.pad].pan->load();
        }

        // Equal power pan law.
        const float angle = (pan + 1.0f) * juce::MathConstants<float>::pi * 0.25f;
        const float gainL = gain * std::cos (angle) * juce::MathConstants<float>::sqrt2;
        const float gainR = gain * std::sin (angle) * juce::MathConstants<float>::sqrt2;

        for (int i = 0; i < numSamples; ++i)
        {
            const int index = (int) v.position;

            if (index >= length - 1 || v.fadeRemaining == 0)
            {
                v.sample = nullptr;
                break;
            }

            const float frac = (float) (v.position - (double) index);
            float l = srcL[index] + frac * (srcL[index + 1] - srcL[index]);
            float r = srcR[index] + frac * (srcR[index + 1] - srcR[index]);

            if (v.fadeRemaining > 0)
            {
                const float fade = (float) v.fadeRemaining / (float) v.fadeLength;
                l *= fade;
                r *= fade;
                --v.fadeRemaining;
            }

            if (outR != nullptr)
            {
                outL[i] += l * gainL;
                outR[i] += r * gainR;
            }
            else
            {
                outL[i] += 0.5f * (l * gainL + r * gainR);
            }

            v.position += v.increment;
        }
    }
}

//==============================================================================
SampleData::Ptr DrumPadProcessor::decodeFile (const juce::File& file)
{
    std::unique_ptr<juce::AudioFormatReader> reader (formatManager.createReaderFor (file));

    if (reader == nullptr || reader->sampleRate <= 0.0)
        return nullptr;

    const auto maxLength = (juce::int64) (maxSampleSeconds * reader->sampleRate);
    const int length = (int) juce::jmin (reader->lengthInSamples, maxLength);
    const int channels = (int) juce::jlimit (1u, 2u, reader->numChannels);

    if (length <= 1)
        return nullptr;

    SampleData::Ptr sample = new SampleData();
    sample->buffer.setSize (channels, length);
    sample->sampleRate = reader->sampleRate;
    sample->file = file;

    if (! reader->read (&sample->buffer, 0, length, 0, true, channels > 1))
        return nullptr;

    return sample;
}

void DrumPadProcessor::setSlotSample (int slot, SampleData::Ptr newSample, const juce::File& file)
{
    {
        const juce::ScopedLock sl (metaLock);

        if (newSample != nullptr)
            sampleHistory.add (newSample);

        pads[(size_t) slot].file = file;
    }

    const juce::SpinLock::ScopedLockType lock (sampleLock);
    pads[(size_t) slot].sample = newSample;
}

bool DrumPadProcessor::loadSampleIntoPad (int pad, const juce::File& file)
{
    if (! juce::isPositiveAndBelow (pad, numPads))
        return false;

    auto sample = decodeFile (file);

    if (sample == nullptr)
        return false;

    setSlotSample (pad, sample, file);
    return true;
}

void DrumPadProcessor::clearPad (int pad)
{
    if (juce::isPositiveAndBelow (pad, numPads))
        setSlotSample (pad, nullptr, {});
}

void DrumPadProcessor::previewFile (const juce::File& file)
{
    if (auto sample = decodeFile (file))
    {
        setSlotSample (previewSlot, sample, file);
        pendingAuditions[(size_t) previewSlot] = 1.0f;
    }
}

void DrumPadProcessor::auditionPad (int pad, float velocity)
{
    if (juce::isPositiveAndBelow (pad, numPads))
        pendingAuditions[(size_t) pad] = juce::jlimit (0.01f, 1.0f, velocity);
}

juce::File DrumPadProcessor::getPadFile (int pad) const
{
    const juce::ScopedLock sl (metaLock);
    return pads[(size_t) pad].file;
}

bool DrumPadProcessor::isPadFileMissing (int pad) const
{
    auto file = getPadFile (pad);
    return file != juce::File() && ! file.existsAsFile();
}

void DrumPadProcessor::startMidiLearn (int pad, bool learnAll)
{
    learningAll = learnAll;
    learningPad = juce::jlimit (0, numPads - 1, pad);
}

void DrumPadProcessor::cancelMidiLearn()
{
    learningAll = false;
    learningPad = -1;
}

void DrumPadProcessor::resetNoteMapToDefault()
{
    // General MIDI drum notes starting at C1 (36), the usual layout for pad controllers.
    for (int i = 0; i < numPads; ++i)
        pads[(size_t) i].note = 36 + i;
}

juce::File DrumPadProcessor::getBrowserFolder() const
{
    const juce::ScopedLock sl (metaLock);
    return browserFolder;
}

void DrumPadProcessor::setBrowserFolder (const juce::File& folder)
{
    const juce::ScopedLock sl (metaLock);
    browserFolder = folder;
}

juce::File DrumPadProcessor::findSpliceFolder()
{
    const auto home = juce::File::getSpecialLocation (juce::File::userHomeDirectory);
    const auto docs = juce::File::getSpecialLocation (juce::File::userDocumentsDirectory);

    // Default locations used by the Splice desktop app on macOS and Windows.
    const juce::File candidates[] = {
        home.getChildFile ("Splice/sounds"),
        home.getChildFile ("Splice"),
        docs.getChildFile ("Splice/sounds"),
        docs.getChildFile ("Splice"),
        home.getChildFile ("Music/Splice/sounds"),
        home.getChildFile ("Music/Splice"),
    };

    for (const auto& c : candidates)
        if (c.isDirectory())
            return c;

    return home;
}

void DrumPadProcessor::timerCallback()
{
    // Release decoded samples that are no longer used by a pad or a playing voice.
    const juce::ScopedLock sl (metaLock);

    for (int i = sampleHistory.size(); --i >= 0;)
        if (sampleHistory.getObjectPointerUnchecked (i)->getReferenceCount() == 1)
            sampleHistory.remove (i);
}

//==============================================================================
void DrumPadProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    auto state = parameters.copyState();

    juce::ValueTree padsTree ("Pads");

    for (int i = 0; i < numPads; ++i)
    {
        juce::ValueTree p ("Pad");
        p.setProperty ("index", i, nullptr);
        p.setProperty ("note", getPadNote (i), nullptr);
        p.setProperty ("choke", getPadChokeGroup (i), nullptr);
        p.setProperty ("oneShot", getPadOneShot (i), nullptr);
        p.setProperty ("file", getPadFile (i).getFullPathName(), nullptr);
        padsTree.appendChild (p, nullptr);
    }

    state.removeChild (state.getChildWithName ("Pads"), nullptr);
    state.appendChild (padsTree, nullptr);
    state.setProperty ("browserFolder", getBrowserFolder().getFullPathName(), nullptr);

    if (auto xml = state.createXml())
        copyXmlToBinary (*xml, destData);
}

void DrumPadProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    auto xml = getXmlFromBinary (data, sizeInBytes);

    if (xml == nullptr || ! xml->hasTagName (parameters.state.getType()))
        return;

    auto state = juce::ValueTree::fromXml (*xml);
    auto padsTree = state.getChildWithName ("Pads");

    auto folder = state.getProperty ("browserFolder").toString();
    if (juce::File::isAbsolutePath (folder) && juce::File (folder).isDirectory())
        setBrowserFolder (juce::File (folder));

    state.removeChild (padsTree, nullptr);
    parameters.replaceState (state);

    for (const auto& p : padsTree)
    {
        const int i = p.getProperty ("index", -1);

        if (! juce::isPositiveAndBelow (i, numPads))
            continue;

        setPadNote (i, p.getProperty ("note", 36 + i));
        setPadChokeGroup (i, p.getProperty ("choke", 0));
        setPadOneShot (i, p.getProperty ("oneShot", true));

        const auto path = p.getProperty ("file").toString();

        if (path.isEmpty() || ! juce::File::isAbsolutePath (path))
        {
            clearPad (i);
            continue;
        }

        const juce::File file (path);

        if (auto sample = file.existsAsFile() ? decodeFile (file) : nullptr)
            setSlotSample (i, sample, file);
        else
            setSlotSample (i, nullptr, file);   // remember the path so the UI can show it as missing
    }
}

//==============================================================================
juce::AudioProcessorEditor* DrumPadProcessor::createEditor()
{
    return new DrumPadEditor (*this);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new DrumPadProcessor();
}
