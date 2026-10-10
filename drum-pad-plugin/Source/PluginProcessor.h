#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <array>
#include <atomic>

namespace drumpad
{
    constexpr int numPads = 16;
    constexpr int previewSlot = numPads;       // hidden slot used to audition files in the browser
    constexpr int numSlots = numPads + 1;
    constexpr int maxVoices = 64;
    constexpr int maxChokeGroups = 8;
    constexpr double maxSampleSeconds = 60.0;

    juce::String padParamId (const char* name, int pad);
    juce::String noteName (int note);
}

//==============================================================================
/** A decoded audio file. Shared between the message thread and the audio thread
    via reference counting; the processor keeps every instance alive in a history
    list until nobody else uses it, so the audio thread never frees memory. */
struct SampleData : public juce::ReferenceCountedObject
{
    using Ptr = juce::ReferenceCountedObjectPtr<SampleData>;

    juce::AudioBuffer<float> buffer;
    double sampleRate = 44100.0;
    juce::File file;
};

//==============================================================================
class DrumPadProcessor : public juce::AudioProcessor,
                         private juce::Timer
{
public:
    DrumPadProcessor();
    ~DrumPadProcessor() override;

    //==========================================================================
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    //==========================================================================
    // Pad control, called from the editor (message thread).
    bool loadSampleIntoPad (int pad, const juce::File& file);
    void clearPad (int pad);
    void previewFile (const juce::File& file);
    void auditionPad (int pad, float velocity = 0.8f);

    juce::File getPadFile (int pad) const;
    bool isPadFileMissing (int pad) const;

    int getPadNote (int pad) const              { return pads[(size_t) pad].note.load(); }
    void setPadNote (int pad, int note)         { pads[(size_t) pad].note = juce::jlimit (0, 127, note); }
    int getPadChokeGroup (int pad) const        { return pads[(size_t) pad].chokeGroup.load(); }
    void setPadChokeGroup (int pad, int group)  { pads[(size_t) pad].chokeGroup = juce::jlimit (0, drumpad::maxChokeGroups, group); }
    bool getPadOneShot (int pad) const          { return pads[(size_t) pad].oneShot.load(); }
    void setPadOneShot (int pad, bool oneShot)  { pads[(size_t) pad].oneShot = oneShot; }
    int getPadTriggerCount (int pad) const      { return pads[(size_t) pad].triggerCount.load(); }

    /** MIDI learn: the next incoming note is assigned to this pad. When learnAll
        is set, learning then moves on to the following pad until pad 16. */
    void startMidiLearn (int pad, bool learnAll);
    void cancelMidiLearn();
    int getLearningPad() const                  { return learningPad.load(); }
    int getLastNoteReceived() const             { return lastNoteReceived.load(); }

    void resetNoteMapToDefault();

    juce::File getBrowserFolder() const;
    void setBrowserFolder (const juce::File& folder);
    static juce::File findSpliceFolder();
    static juce::String getSupportedWildcard() { return "*.wav;*.aif;*.aiff;*.flac;*.mp3;*.ogg"; }

    juce::AudioProcessorValueTreeState parameters;
    juce::AudioFormatManager formatManager;

private:
    struct Pad
    {
        std::atomic<int> note { 36 };
        std::atomic<int> chokeGroup { 0 };
        std::atomic<bool> oneShot { true };
        std::atomic<int> triggerCount { 0 };
        SampleData::Ptr sample;         // guarded by sampleLock
        juce::File file;                // guarded by metaLock; may point to a missing file
    };

    struct Voice
    {
        SampleData::Ptr sample;
        int pad = -1;
        int note = -1;
        double position = 0.0;
        double increment = 1.0;
        float velocityGain = 1.0f;
        int fadeRemaining = -1;         // -1 means not fading
        int fadeLength = 1;
        juce::uint32 age = 0;

        bool isActive() const noexcept { return sample != nullptr; }
    };

    struct PadParams
    {
        std::atomic<float>* volumeDb = nullptr;
        std::atomic<float>* pan = nullptr;
        std::atomic<float>* tune = nullptr;
    };

    static juce::AudioProcessorValueTreeState::ParameterLayout createParameterLayout();

    void timerCallback() override;
    SampleData::Ptr decodeFile (const juce::File& file);
    void setSlotSample (int slot, SampleData::Ptr newSample, const juce::File& file);

    void handleMidi (const juce::MidiMessage& message);
    void triggerSlot (int slot, int note, float velocity);
    void releaseNote (int note);
    void startFade (Voice& voice, double seconds);
    void renderVoices (juce::AudioBuffer<float>& buffer, int start, int numSamples);

    std::array<Pad, drumpad::numSlots> pads;
    std::array<PadParams, drumpad::numPads> padParams;
    std::atomic<float>* masterVolumeDb = nullptr;

    juce::SpinLock sampleLock;
    std::array<SampleData::Ptr, drumpad::numSlots> audioThreadSamples;  // audio thread copy

    mutable juce::CriticalSection metaLock;
    juce::ReferenceCountedArray<SampleData> sampleHistory;              // message thread only
    juce::File browserFolder;                                           // guarded by metaLock

    std::array<Voice, drumpad::maxVoices> voices;
    juce::uint32 voiceAgeCounter = 0;
    double currentSampleRate = 44100.0;

    std::atomic<int> learningPad { -1 };
    std::atomic<bool> learningAll { false };
    std::atomic<int> lastNoteReceived { -1 };
    std::array<std::atomic<float>, drumpad::numSlots> pendingAuditions {};

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (DrumPadProcessor)
};
