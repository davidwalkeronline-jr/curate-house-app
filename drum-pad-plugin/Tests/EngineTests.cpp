// Headless checks for the drum pad engine: sample rate handling, MIDI
// triggering, MIDI learn, choke groups and session state recall.

#include "PluginProcessor.h"

namespace
{
    int failures = 0;

    void check (bool condition, const juce::String& description)
    {
        std::cout << (condition ? "  PASS  " : "  FAIL  ") << description << std::endl;
        if (! condition)
            ++failures;
    }

    // Writes a mono 1 kHz sine of the given length to a WAV file.
    juce::File writeSine (const juce::File& dir, double sampleRate, int bits, double seconds)
    {
        auto file = dir.getChildFile ("sine_" + juce::String ((int) sampleRate) + "_" + juce::String (bits) + ".wav");
        file.deleteFile();

        const int length = (int) (sampleRate * seconds);
        juce::AudioBuffer<float> buffer (1, length);
        for (int i = 0; i < length; ++i)
            buffer.setSample (0, i, 0.5f * std::sin (juce::MathConstants<double>::twoPi * 1000.0 * i / sampleRate));

        juce::WavAudioFormat wav;
        auto stream = file.createOutputStream();
        std::unique_ptr<juce::AudioFormatWriter> writer (
            wav.createWriterFor (stream.get(), sampleRate, 1, bits, {}, 0));
        stream.release();
        writer->writeFromAudioSampleBuffer (buffer, 0, length);
        return file;
    }

    struct RenderResult
    {
        int soundingSamples = 0;
        double frequency = 0.0;
        float peak = 0.0f;
    };

    // Plays one note and measures how long the output sounds and its pitch.
    RenderResult renderNote (DrumPadProcessor& proc, double hostRate, int note, double seconds = 1.0)
    {
        const int blockSize = 512;
        proc.setPlayConfigDetails (0, 2, hostRate, blockSize);
        proc.prepareToPlay (hostRate, blockSize);

        juce::AudioBuffer<float> block (2, blockSize);
        std::vector<float> output;

        const int totalBlocks = (int) (hostRate * seconds) / blockSize;

        for (int b = 0; b < totalBlocks; ++b)
        {
            juce::MidiBuffer midi;
            if (b == 0)
                midi.addEvent (juce::MidiMessage::noteOn (1, note, (juce::uint8) 127), 0);

            proc.processBlock (block, midi);
            output.insert (output.end(), block.getReadPointer (0), block.getReadPointer (0) + blockSize);
        }

        RenderResult r;
        int crossings = 0;
        int last = 0;

        for (size_t i = 0; i < output.size(); ++i)
        {
            r.peak = juce::jmax (r.peak, std::abs (output[i]));

            if (std::abs (output[i]) > 1.0e-4f)
                last = (int) i;

            if (i > 0 && output[i - 1] < 0.0f && output[i] >= 0.0f)
                ++crossings;
        }

        r.soundingSamples = last + 1;
        r.frequency = r.soundingSamples > 0 ? crossings * hostRate / r.soundingSamples : 0.0;
        return r;
    }
}

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    auto dir = juce::File::getSpecialLocation (juce::File::tempDirectory).getChildFile ("drumpad_tests");
    dir.createDirectory();

    std::cout << "Sample rate handling" << std::endl;

    // Splice packs are mostly 44.1 kHz WAV, some 48 kHz, in 16 or 24 bit.
    const double fileRates[] = { 44100.0, 48000.0, 96000.0 };
    const int bitDepths[] = { 16, 24 };
    const double hostRates[] = { 44100.0, 48000.0, 96000.0 };
    const double sampleSeconds = 0.5;

    for (auto fileRate : fileRates)
    {
        for (auto bits : bitDepths)
        {
            auto file = writeSine (dir, fileRate, bits, sampleSeconds);

            for (auto hostRate : hostRates)
            {
                DrumPadProcessor proc;
                const bool loaded = proc.loadSampleIntoPad (0, file);
                auto r = renderNote (proc, hostRate, 36);

                const double expectedLength = sampleSeconds * hostRate;
                const bool lengthOk = std::abs (r.soundingSamples - expectedLength) < hostRate * 0.002;
                const bool pitchOk = std::abs (r.frequency - 1000.0) < 5.0;

                check (loaded && lengthOk && pitchOk && r.peak > 0.3f,
                       juce::String ((int) fileRate) + " Hz " + juce::String (bits) + " bit file in a "
                         + juce::String ((int) hostRate) + " Hz session: "
                         + juce::String (r.frequency, 1) + " Hz, "
                         + juce::String (r.soundingSamples / hostRate, 3) + " s");
            }
        }
    }

    std::cout << "MIDI mapping" << std::endl;
    {
        auto file = writeSine (dir, 44100.0, 24, 0.25);
        DrumPadProcessor proc;
        proc.loadSampleIntoPad (3, file);

        check (renderNote (proc, 48000.0, 39).peak > 0.3f, "Pad 4 plays from its default note D#1 (39)");
        check (renderNote (proc, 48000.0, 60).peak == 0.0f, "Unmapped note 60 is silent");

        proc.startMidiLearn (3, false);
        renderNote (proc, 48000.0, 60);
        check (proc.getPadNote (3) == 60 && proc.getLearningPad() == -1, "MIDI Learn assigns note 60 to pad 4");
        check (renderNote (proc, 48000.0, 60).peak > 0.3f, "Pad 4 now plays from note 60");

        proc.startMidiLearn (0, true);
        for (int i = 0; i < drumpad::numPads; ++i)
            renderNote (proc, 48000.0, 70 + i, 0.05);

        bool allLearned = proc.getLearningPad() == -1;
        for (int i = 0; i < drumpad::numPads; ++i)
            allLearned = allLearned && proc.getPadNote (i) == 70 + i;
        check (allLearned, "Learn All assigns 16 keys to pads 1 to 16 in order");
    }

    std::cout << "Choke groups" << std::endl;
    {
        auto longFile = writeSine (dir, 44100.0, 16, 1.0);
        DrumPadProcessor proc;
        proc.loadSampleIntoPad (0, longFile);
        proc.loadSampleIntoPad (1, longFile);
        proc.setPadChokeGroup (0, 1);
        proc.setPadChokeGroup (1, 1);
        proc.setPlayConfigDetails (0, 2, 48000.0, 512);
        proc.prepareToPlay (48000.0, 512);

        juce::AudioBuffer<float> block (2, 512);
        juce::MidiBuffer midi;
        midi.addEvent (juce::MidiMessage::noteOn (1, 36, (juce::uint8) 127), 0);
        proc.processBlock (block, midi);

        midi.clear();
        midi.addEvent (juce::MidiMessage::noteOn (1, 37, (juce::uint8) 127), 0);
        proc.processBlock (block, midi);

        // Mute pad 2 so only pad 1 (which should have been choked) could be heard.
        proc.parameters.getParameter (drumpad::padParamId ("volume", 1))->setValueNotifyingHost (0.0f);

        float peak = 0.0f;
        for (int b = 0; b < 4; ++b)
        {
            midi.clear();
            proc.processBlock (block, midi);
            peak = juce::jmax (peak, block.getMagnitude (0, 0, 512));
        }

        check (peak < 1.0e-3f, "Hitting pad 2 chokes pad 1 in the same group");
    }

    std::cout << "Session recall" << std::endl;
    {
        auto file = writeSine (dir, 48000.0, 24, 0.25);
        juce::MemoryBlock state;

        {
            DrumPadProcessor proc;
            proc.loadSampleIntoPad (5, file);
            proc.setPadNote (5, 42);
            proc.setPadChokeGroup (5, 2);
            proc.setPadOneShot (5, false);
            proc.parameters.getParameter (drumpad::padParamId ("tune", 5))->setValueNotifyingHost (0.75f);
            proc.getStateInformation (state);
        }

        DrumPadProcessor restored;
        restored.setStateInformation (state.getData(), (int) state.getSize());

        check (restored.getPadFile (5) == file, "Sample path is restored");
        check (restored.getPadNote (5) == 42, "Note mapping is restored");
        check (restored.getPadChokeGroup (5) == 2 && ! restored.getPadOneShot (5), "Choke group and mode are restored");
        check (std::abs (restored.parameters.getParameter (drumpad::padParamId ("tune", 5))->getValue() - 0.75f) < 0.01f,
               "Tune parameter is restored");
        check (renderNote (restored, 44100.0, 42).peak > 0.3f, "Restored pad plays");
    }

    dir.deleteRecursively();

    std::cout << (failures == 0 ? "All tests passed" : juce::String (failures) + " test(s) failed") << std::endl;
    return failures == 0 ? 0 : 1;
}
