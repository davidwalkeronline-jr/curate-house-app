#pragma once

#include <juce_audio_utils/juce_audio_utils.h>
#include "PluginProcessor.h"

//==============================================================================
/** Curate House colours: navy, gold and cream. */
namespace palette
{
    const juce::Colour navy      { 0xff1b2a41 };
    const juce::Colour navyDark  { 0xff111b2b };
    const juce::Colour navyLight { 0xff26395a };
    const juce::Colour gold      { 0xffb8935a };
    const juce::Colour cream     { 0xfff7f3ec };
    const juce::Colour gray      { 0xff9a9a9a };
}

class DrumPadLookAndFeel : public juce::LookAndFeel_V4
{
public:
    DrumPadLookAndFeel();

    void drawRotarySlider (juce::Graphics&, int x, int y, int width, int height,
                           float sliderPos, float startAngle, float endAngle, juce::Slider&) override;
};

//==============================================================================
class DrumPadEditor;

/** One clickable pad in the 4x4 grid. Accepts files dragged from Finder,
    Explorer or the Splice app, and files dragged from the built in browser. */
class PadComponent : public juce::Component,
                     public juce::FileDragAndDropTarget,
                     public juce::DragAndDropTarget
{
public:
    PadComponent (DrumPadEditor& owner, int index);

    void paint (juce::Graphics&) override;
    void mouseDown (const juce::MouseEvent&) override;

    bool isInterestedInFileDrag (const juce::StringArray& files) override;
    void fileDragEnter (const juce::StringArray&, int, int) override  { setDragHover (true); }
    void fileDragExit (const juce::StringArray&) override              { setDragHover (false); }
    void filesDropped (const juce::StringArray& files, int, int) override;

    bool isInterestedInDragSource (const SourceDetails&) override;
    void itemDragEnter (const SourceDetails&) override                 { setDragHover (true); }
    void itemDragExit (const SourceDetails&) override                  { setDragHover (false); }
    void itemDropped (const SourceDetails&) override;

    float flash = 0.0f;
    int lastTriggerCount = 0;

private:
    void setDragHover (bool shouldHover);

    DrumPadEditor& owner;
    const int index;
    bool dragHover = false;
};

//==============================================================================
class DrumPadEditor : public juce::AudioProcessorEditor,
                      public juce::DragAndDropContainer,
                      private juce::FileBrowserListener,
                      private juce::Timer
{
public:
    explicit DrumPadEditor (DrumPadProcessor&);
    ~DrumPadEditor() override;

    void paint (juce::Graphics&) override;
    void resized() override;

    // Used by the pads.
    DrumPadProcessor& getProcessor()           { return processor; }
    int getSelectedPad() const                 { return selectedPad; }
    void selectPad (int pad);
    void loadFilesStartingAt (int pad, const juce::StringArray& files);
    void loadFileFromBrowserInto (int pad);
    void showPadMenu (int pad);
    bool isBrowserDrag (const juce::DragAndDropTarget::SourceDetails&) const;

private:
    void timerCallback() override;

    void selectionChanged() override {}
    void fileClicked (const juce::File&, const juce::MouseEvent&) override;
    void fileDoubleClicked (const juce::File&) override;
    void browserRootChanged (const juce::File&) override {}

    void setBrowserRoot (const juce::File& folder);
    void chooseBrowserFolder();
    void chooseFileForPad (int pad);
    void refreshDetailPanel();
    void showError (const juce::String& message);

    void configureKnob (juce::Slider& slider, juce::Label& label, const juce::String& text);

    DrumPadProcessor& processor;
    DrumPadLookAndFeel lookAndFeel;

    int selectedPad = 0;
    juce::OwnedArray<PadComponent> pads;

    // Browser
    juce::TimeSliceThread browserThread { "Sample browser" };
    juce::WildcardFileFilter audioFilter { DrumPadProcessor::getSupportedWildcard(), "*", "Audio files" };
    juce::DirectoryContentsList browserContents { &audioFilter, browserThread };
    juce::FileTreeComponent browserTree { browserContents };
    juce::Label browserTitle, browserPath;
    juce::TextButton spliceButton { "Splice" }, chooseFolderButton { "Folder..." }, upButton { "Up" };
    juce::ToggleButton previewToggle { "Preview on click" };

    // Header
    juce::Slider masterSlider;
    juce::Label masterLabel;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> masterAttachment;

    // Selected pad panel
    juce::Label padTitle, padFileLabel;
    juce::TextButton loadButton { "Load Sample..." }, clearButton { "Clear" };
    juce::TextButton learnButton { "MIDI Learn" }, learnAllButton { "Learn All 16" }, resetNotesButton { "Reset Notes" };
    juce::Label noteLabel, chokeLabel, modeLabel;
    juce::ComboBox noteBox, chokeBox, modeBox;
    juce::Slider volumeSlider, panSlider, tuneSlider;
    juce::Label volumeLabel, panLabel, tuneLabel;
    std::unique_ptr<juce::AudioProcessorValueTreeState::SliderAttachment> volumeAttachment, panAttachment, tuneAttachment;

    juce::Label statusLabel;
    int lastLearningPad = -2;
    int lastNoteSeen = -2;

    std::unique_ptr<juce::FileChooser> fileChooser;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (DrumPadEditor)
};
