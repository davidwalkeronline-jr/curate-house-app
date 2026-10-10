#include "PluginEditor.h"

using namespace drumpad;

namespace
{
    const juce::String browserDragId = "CurateDrumPadBrowserFile";

    juce::String displayName (const juce::File& file)
    {
        return file.getFileNameWithoutExtension();
    }
}

//==============================================================================
DrumPadLookAndFeel::DrumPadLookAndFeel()
{
    setColour (juce::ResizableWindow::backgroundColourId, palette::navyDark);
    setColour (juce::Label::textColourId, palette::cream);
    setColour (juce::TextButton::buttonColourId, palette::navyLight);
    setColour (juce::TextButton::buttonOnColourId, palette::gold);
    setColour (juce::TextButton::textColourOffId, palette::cream);
    setColour (juce::TextButton::textColourOnId, palette::navyDark);
    setColour (juce::ComboBox::backgroundColourId, palette::navyLight);
    setColour (juce::ComboBox::textColourId, palette::cream);
    setColour (juce::ComboBox::outlineColourId, palette::navyLight.brighter (0.2f));
    setColour (juce::ComboBox::arrowColourId, palette::gold);
    setColour (juce::PopupMenu::backgroundColourId, palette::navy);
    setColour (juce::PopupMenu::textColourId, palette::cream);
    setColour (juce::PopupMenu::highlightedBackgroundColourId, palette::gold);
    setColour (juce::PopupMenu::highlightedTextColourId, palette::navyDark);
    setColour (juce::ToggleButton::textColourId, palette::cream);
    setColour (juce::ToggleButton::tickColourId, palette::gold);
    setColour (juce::ToggleButton::tickDisabledColourId, palette::gray);
    setColour (juce::Slider::textBoxTextColourId, palette::cream);
    setColour (juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
    setColour (juce::Slider::rotarySliderFillColourId, palette::gold);
    setColour (juce::Slider::thumbColourId, palette::gold);
    setColour (juce::Slider::trackColourId, palette::gold);
    setColour (juce::Slider::backgroundColourId, palette::navyLight);
    setColour (juce::TreeView::backgroundColourId, palette::navy);
    setColour (juce::TreeView::selectedItemBackgroundColourId, palette::gold.withAlpha (0.35f));
    setColour (juce::TreeView::linesColourId, palette::gray);
    setColour (juce::DirectoryContentsDisplayComponent::textColourId, palette::cream);
    setColour (juce::DirectoryContentsDisplayComponent::highlightColourId, palette::gold.withAlpha (0.35f));
    setColour (juce::DirectoryContentsDisplayComponent::highlightedTextColourId, palette::cream);
    setColour (juce::ScrollBar::thumbColourId, palette::gold.withAlpha (0.6f));
    setColour (juce::AlertWindow::backgroundColourId, palette::navy);
    setColour (juce::AlertWindow::textColourId, palette::cream);
}

void DrumPadLookAndFeel::drawRotarySlider (juce::Graphics& g, int x, int y, int width, int height,
                                           float sliderPos, float startAngle, float endAngle, juce::Slider&)
{
    auto bounds = juce::Rectangle<int> (x, y, width, height).toFloat().reduced (6.0f);
    const float radius = juce::jmin (bounds.getWidth(), bounds.getHeight()) / 2.0f;
    const auto centre = bounds.getCentre();
    const float lineW = 3.0f;
    const float arcRadius = radius - lineW;
    const float angle = startAngle + sliderPos * (endAngle - startAngle);

    juce::Path track;
    track.addCentredArc (centre.x, centre.y, arcRadius, arcRadius, 0.0f, startAngle, endAngle, true);
    g.setColour (palette::navyLight);
    g.strokePath (track, juce::PathStrokeType (lineW, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));

    juce::Path value;
    value.addCentredArc (centre.x, centre.y, arcRadius, arcRadius, 0.0f, startAngle, angle, true);
    g.setColour (palette::gold);
    g.strokePath (value, juce::PathStrokeType (lineW, juce::PathStrokeType::curved, juce::PathStrokeType::rounded));

    const juce::Point<float> tip (centre.x + (arcRadius - 6.0f) * std::cos (angle - juce::MathConstants<float>::halfPi),
                                  centre.y + (arcRadius - 6.0f) * std::sin (angle - juce::MathConstants<float>::halfPi));
    g.setColour (palette::cream);
    g.drawLine ({ centre, tip }, 2.0f);
}

//==============================================================================
PadComponent::PadComponent (DrumPadEditor& o, int i) : owner (o), index (i) {}

void PadComponent::paint (juce::Graphics& g)
{
    auto& proc = owner.getProcessor();
    auto bounds = getLocalBounds().toFloat().reduced (4.0f);

    const bool selected = owner.getSelectedPad() == index;
    const bool learning = proc.getLearningPad() == index;
    const auto file = proc.getPadFile (index);
    const bool missing = proc.isPadFileMissing (index);
    const bool loaded = file != juce::File() && ! missing;

    auto fill = loaded ? palette::navyLight : palette::navy;
    fill = fill.interpolatedWith (palette::gold, juce::jlimit (0.0f, 1.0f, flash) * 0.75f);

    if (dragHover)
        fill = fill.interpolatedWith (palette::gold, 0.35f);

    g.setColour (fill);
    g.fillRoundedRectangle (bounds, 8.0f);

    if (selected || learning || dragHover)
    {
        g.setColour (palette::gold.withAlpha (learning ? 0.6f + 0.4f * (float) std::sin (juce::Time::getMillisecondCounter() / 120.0) : 1.0f));
        g.drawRoundedRectangle (bounds.reduced (1.0f), 8.0f, selected ? 2.5f : 2.0f);
    }
    else
    {
        g.setColour (palette::navyLight.brighter (0.15f));
        g.drawRoundedRectangle (bounds.reduced (0.5f), 8.0f, 1.0f);
    }

    auto text = bounds.reduced (10.0f, 8.0f);

    g.setColour (palette::gold);
    g.setFont (juce::FontOptions (13.0f, juce::Font::bold));
    g.drawText (juce::String (index + 1), text.removeFromTop (16.0f), juce::Justification::topLeft);

    g.setColour (palette::cream.withAlpha (0.8f));
    g.setFont (juce::FontOptions (12.0f));
    g.drawText (noteName (proc.getPadNote (index)), text.withHeight (16.0f), juce::Justification::topRight);

    juce::String label;
    if (learning)                    label = "Hit a key...";
    else if (missing)                label = "Missing: " + displayName (file);
    else if (loaded)                 label = displayName (file);
    else                             label = "Drop sample";

    g.setColour (loaded || learning ? palette::cream : palette::gray);
    g.setFont (juce::FontOptions (loaded ? 14.0f : 12.5f, loaded ? juce::Font::bold : juce::Font::plain));
    g.drawFittedText (label, text.toNearestInt(), juce::Justification::centred, 3, 0.8f);

    if (proc.getPadChokeGroup (index) > 0)
    {
        g.setColour (palette::gold.withAlpha (0.8f));
        g.setFont (juce::FontOptions (11.0f));
        g.drawText ("Choke " + juce::String (proc.getPadChokeGroup (index)), text, juce::Justification::bottomLeft);
    }

    if (! proc.getPadOneShot (index))
    {
        g.setColour (palette::gold.withAlpha (0.8f));
        g.setFont (juce::FontOptions (11.0f));
        g.drawText ("Gate", text, juce::Justification::bottomRight);
    }
}

void PadComponent::mouseDown (const juce::MouseEvent& e)
{
    owner.selectPad (index);

    if (e.mods.isPopupMenu())
    {
        owner.showPadMenu (index);
        return;
    }

    // Clicking higher on the pad plays louder, like a velocity sensitive pad.
    const float velocity = 1.0f - 0.7f * ((float) e.y / (float) juce::jmax (1, getHeight()));
    owner.getProcessor().auditionPad (index, velocity);
}

bool PadComponent::isInterestedInFileDrag (const juce::StringArray& files)
{
    for (const auto& f : files)
        if (juce::File (f).hasFileExtension (DrumPadProcessor::getSupportedWildcard().removeCharacters ("*")))
            return true;

    return false;
}

void PadComponent::filesDropped (const juce::StringArray& files, int, int)
{
    setDragHover (false);
    owner.loadFilesStartingAt (index, files);
}

bool PadComponent::isInterestedInDragSource (const SourceDetails& details)
{
    return owner.isBrowserDrag (details);
}

void PadComponent::itemDropped (const SourceDetails&)
{
    setDragHover (false);
    owner.loadFileFromBrowserInto (index);
}

void PadComponent::setDragHover (bool shouldHover)
{
    dragHover = shouldHover;
    repaint();
}

//==============================================================================
DrumPadEditor::DrumPadEditor (DrumPadProcessor& p)
    : AudioProcessorEditor (&p), processor (p)
{
    setLookAndFeel (&lookAndFeel);

    // Pads
    for (int i = 0; i < numPads; ++i)
    {
        auto* pad = pads.add (new PadComponent (*this, i));
        pad->lastTriggerCount = processor.getPadTriggerCount (i);
        addAndMakeVisible (pad);
    }

    // Browser
    browserThread.startThread (juce::Thread::Priority::low);
    browserTree.setDragAndDropDescription (browserDragId);
    browserTree.addListener (this);
    browserTree.setColour (juce::FileTreeComponent::backgroundColourId, palette::navy);
    addAndMakeVisible (browserTree);

    browserTitle.setText ("SAMPLE BROWSER", juce::dontSendNotification);
    browserTitle.setFont (juce::FontOptions (12.0f, juce::Font::bold));
    browserTitle.setColour (juce::Label::textColourId, palette::gold);
    addAndMakeVisible (browserTitle);

    browserPath.setFont (juce::FontOptions (11.0f));
    browserPath.setColour (juce::Label::textColourId, palette::gray);
    browserPath.setMinimumHorizontalScale (0.6f);
    addAndMakeVisible (browserPath);

    spliceButton.setTooltip ("Jump to your Splice sample folder");
    spliceButton.onClick = [this] { setBrowserRoot (DrumPadProcessor::findSpliceFolder()); };
    chooseFolderButton.onClick = [this] { chooseBrowserFolder(); };
    upButton.onClick = [this]
    {
        auto parent = processor.getBrowserFolder().getParentDirectory();
        if (parent.isDirectory())
            setBrowserRoot (parent);
    };
    previewToggle.setToggleState (true, juce::dontSendNotification);

    for (auto* c : std::initializer_list<juce::Component*> { &spliceButton, &chooseFolderButton, &upButton, &previewToggle })
        addAndMakeVisible (c);

    setBrowserRoot (processor.getBrowserFolder());

    // Master volume
    configureKnob (masterSlider, masterLabel, "Master");
    masterAttachment = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment> (processor.parameters, "master", masterSlider);

    // Selected pad panel
    padTitle.setFont (juce::FontOptions (22.0f, juce::Font::italic));
    padTitle.setColour (juce::Label::textColourId, palette::gold);
    addAndMakeVisible (padTitle);

    padFileLabel.setFont (juce::FontOptions (12.0f));
    padFileLabel.setColour (juce::Label::textColourId, palette::cream.withAlpha (0.75f));
    padFileLabel.setMinimumHorizontalScale (0.6f);
    addAndMakeVisible (padFileLabel);

    loadButton.onClick = [this] { chooseFileForPad (selectedPad); };
    clearButton.onClick = [this] { processor.clearPad (selectedPad); refreshDetailPanel(); };

    learnButton.setClickingTogglesState (false);
    learnButton.setTooltip ("Click, then press a key or pad on your MIDI controller");
    learnButton.onClick = [this]
    {
        if (processor.getLearningPad() >= 0)
            processor.cancelMidiLearn();
        else
            processor.startMidiLearn (selectedPad, false);
    };

    learnAllButton.setTooltip ("Press 16 keys in order to assign pads 1 to 16");
    learnAllButton.onClick = [this]
    {
        if (processor.getLearningPad() >= 0)
            processor.cancelMidiLearn();
        else
        {
            selectPad (0);
            processor.startMidiLearn (0, true);
        }
    };

    resetNotesButton.setTooltip ("Map pads 1 to 16 to notes C1 to D#2 (General MIDI drums)");
    resetNotesButton.onClick = [this]
    {
        processor.cancelMidiLearn();
        processor.resetNoteMapToDefault();
        refreshDetailPanel();
    };

    for (int n = 0; n < 128; ++n)
        noteBox.addItem (noteName (n) + "  (" + juce::String (n) + ")", n + 1);

    noteBox.onChange = [this]
    {
        if (noteBox.getSelectedId() > 0)
            processor.setPadNote (selectedPad, noteBox.getSelectedId() - 1);
        pads[selectedPad]->repaint();
    };

    chokeBox.addItem ("Off", 1);
    for (int c = 1; c <= maxChokeGroups; ++c)
        chokeBox.addItem ("Group " + juce::String (c), c + 1);

    chokeBox.onChange = [this]
    {
        processor.setPadChokeGroup (selectedPad, chokeBox.getSelectedId() - 1);
        pads[selectedPad]->repaint();
    };

    modeBox.addItem ("One Shot", 1);
    modeBox.addItem ("Gate (stop on release)", 2);
    modeBox.onChange = [this]
    {
        processor.setPadOneShot (selectedPad, modeBox.getSelectedId() == 1);
        pads[selectedPad]->repaint();
    };

    for (auto [label, text] : { std::pair<juce::Label*, const char*> { &noteLabel, "MIDI Note" },
                                { &chokeLabel, "Choke" }, { &modeLabel, "Mode" } })
    {
        label->setText (text, juce::dontSendNotification);
        label->setFont (juce::FontOptions (12.0f));
        label->setColour (juce::Label::textColourId, palette::gray);
        addAndMakeVisible (label);
    }

    for (auto* c : std::initializer_list<juce::Component*> { &loadButton, &clearButton, &learnButton, &learnAllButton,
                                                             &resetNotesButton, &noteBox, &chokeBox, &modeBox })
        addAndMakeVisible (c);

    configureKnob (volumeSlider, volumeLabel, "Volume");
    configureKnob (panSlider, panLabel, "Pan");
    configureKnob (tuneSlider, tuneLabel, "Tune");

    statusLabel.setFont (juce::FontOptions (12.0f));
    statusLabel.setColour (juce::Label::textColourId, palette::gray);
    addAndMakeVisible (statusLabel);

    selectPad (0);

    setResizable (true, true);
    setResizeLimits (960, 600, 1800, 1200);
    setSize (1120, 680);

    startTimerHz (30);
}

DrumPadEditor::~DrumPadEditor()
{
    stopTimer();
    browserTree.removeListener (this);
    browserThread.stopThread (2000);
    setLookAndFeel (nullptr);
}

void DrumPadEditor::configureKnob (juce::Slider& slider, juce::Label& label, const juce::String& text)
{
    slider.setSliderStyle (juce::Slider::RotaryHorizontalVerticalDrag);
    slider.setTextBoxStyle (juce::Slider::TextBoxBelow, false, 70, 18);
    slider.setDoubleClickReturnValue (true, 0.0);
    addAndMakeVisible (slider);

    label.setText (text, juce::dontSendNotification);
    label.setFont (juce::FontOptions (12.0f));
    label.setColour (juce::Label::textColourId, palette::gray);
    label.setJustificationType (juce::Justification::centred);
    addAndMakeVisible (label);
}

//==============================================================================
void DrumPadEditor::paint (juce::Graphics& g)
{
    g.fillAll (palette::navyDark);

    auto header = getLocalBounds().removeFromTop (64).reduced (20, 0);

    // Wordmark: "Curate" in cream, "House" in gold italic, then the product name.
    juce::Font serif (juce::FontOptions ("Georgia", 28.0f, juce::Font::plain));
    juce::Font serifItalic (juce::FontOptions ("Georgia", 28.0f, juce::Font::italic));

    juce::AttributedString title;
    title.append ("Curate", serif, palette::cream);
    title.append ("House", serifItalic, palette::gold);
    title.append ("   DRUM PAD", juce::Font (juce::FontOptions (14.0f, juce::Font::bold)), palette::gray);
    title.setJustification (juce::Justification::centredLeft);
    title.draw (g, header.toFloat());

    g.setColour (palette::gold);
    g.fillRect (20, 63, getWidth() - 40, 1);

    // Panel backgrounds
    const int panelTop = 76;
    const int panelHeight = getHeight() - panelTop - 36;
    g.setColour (palette::navy);
    g.fillRoundedRectangle (juce::Rectangle<int> (16, panelTop, 280, panelHeight).toFloat(), 8.0f);
    g.fillRoundedRectangle (juce::Rectangle<int> (getWidth() - 296, panelTop, 280, panelHeight).toFloat(), 8.0f);
}

void DrumPadEditor::resized()
{
    auto area = getLocalBounds();
    auto header = area.removeFromTop (64);

    auto masterArea = header.removeFromRight (180).reduced (8, 2);
    masterLabel.setBounds (masterArea.removeFromLeft (56));
    masterSlider.setBounds (masterArea);
    masterSlider.setTextBoxStyle (juce::Slider::TextBoxRight, false, 64, 18);

    area.removeFromTop (12);
    statusLabel.setBounds (area.removeFromBottom (36).reduced (20, 6));

    // Left: browser
    auto left = area.removeFromLeft (296).withTrimmedLeft (16).reduced (10);
    browserTitle.setBounds (left.removeFromTop (20));
    browserPath.setBounds (left.removeFromTop (18));
    left.removeFromTop (4);
    auto buttons = left.removeFromTop (26);
    const int bw = buttons.getWidth() / 3;
    spliceButton.setBounds (buttons.removeFromLeft (bw).reduced (2, 0));
    chooseFolderButton.setBounds (buttons.removeFromLeft (bw).reduced (2, 0));
    upButton.setBounds (buttons.reduced (2, 0));
    previewToggle.setBounds (left.removeFromBottom (24));
    left.removeFromTop (6);
    browserTree.setBounds (left);

    // Right: selected pad
    auto right = area.removeFromRight (296).withTrimmedRight (16).reduced (14);
    padTitle.setBounds (right.removeFromTop (30));
    padFileLabel.setBounds (right.removeFromTop (20));
    right.removeFromTop (8);

    auto row = right.removeFromTop (28);
    loadButton.setBounds (row.removeFromLeft (row.getWidth() * 2 / 3).reduced (2, 0));
    clearButton.setBounds (row.reduced (2, 0));
    right.removeFromTop (6);

    row = right.removeFromTop (28);
    learnButton.setBounds (row.removeFromLeft (row.getWidth() / 2).reduced (2, 0));
    learnAllButton.setBounds (row.reduced (2, 0));
    right.removeFromTop (6);
    resetNotesButton.setBounds (right.removeFromTop (24).reduced (2, 0));
    right.removeFromTop (10);

    for (auto [label, box] : { std::pair<juce::Label*, juce::ComboBox*> { &noteLabel, &noteBox },
                               { &chokeLabel, &chokeBox }, { &modeLabel, &modeBox } })
    {
        auto r = right.removeFromTop (28);
        label->setBounds (r.removeFromLeft (76));
        box->setBounds (r.reduced (2, 1));
        right.removeFromTop (6);
    }

    right.removeFromTop (8);
    auto knobs = right.removeFromTop (juce::jmin (right.getHeight(), 120));
    const int kw = knobs.getWidth() / 3;

    for (auto [label, slider] : { std::pair<juce::Label*, juce::Slider*> { &volumeLabel, &volumeSlider },
                                  { &panLabel, &panSlider }, { &tuneLabel, &tuneSlider } })
    {
        auto k = knobs.removeFromLeft (kw);
        label->setBounds (k.removeFromTop (18));
        slider->setBounds (k);
    }

    // Centre: 4x4 pad grid, square, with pad 1 bottom left like hardware pad controllers.
    auto centre = area.reduced (12, 0);
    const int size = juce::jmin (centre.getWidth(), centre.getHeight());
    auto grid = centre.withSizeKeepingCentre (size, size);
    const int cell = size / 4;

    for (int i = 0; i < numPads; ++i)
    {
        const int col = i % 4;
        const int rowFromBottom = i / 4;
        pads[i]->setBounds (grid.getX() + col * cell, grid.getBottom() - (rowFromBottom + 1) * cell, cell, cell);
    }
}

//==============================================================================
void DrumPadEditor::selectPad (int pad)
{
    selectedPad = juce::jlimit (0, numPads - 1, pad);

    volumeAttachment.reset();
    panAttachment.reset();
    tuneAttachment.reset();

    auto& apvts = processor.parameters;
    volumeAttachment = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment> (apvts, padParamId ("volume", selectedPad), volumeSlider);
    panAttachment    = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment> (apvts, padParamId ("pan", selectedPad), panSlider);
    tuneAttachment   = std::make_unique<juce::AudioProcessorValueTreeState::SliderAttachment> (apvts, padParamId ("tune", selectedPad), tuneSlider);

    refreshDetailPanel();

    for (auto* p : pads)
        p->repaint();
}

void DrumPadEditor::refreshDetailPanel()
{
    padTitle.setText ("Pad " + juce::String (selectedPad + 1), juce::dontSendNotification);

    const auto file = processor.getPadFile (selectedPad);

    if (file == juce::File())
        padFileLabel.setText ("No sample loaded", juce::dontSendNotification);
    else if (processor.isPadFileMissing (selectedPad))
        padFileLabel.setText ("Missing: " + file.getFullPathName(), juce::dontSendNotification);
    else
        padFileLabel.setText (file.getFileName(), juce::dontSendNotification);

    padFileLabel.setTooltip (file.getFullPathName());

    noteBox.setSelectedId (processor.getPadNote (selectedPad) + 1, juce::dontSendNotification);
    chokeBox.setSelectedId (processor.getPadChokeGroup (selectedPad) + 1, juce::dontSendNotification);
    modeBox.setSelectedId (processor.getPadOneShot (selectedPad) ? 1 : 2, juce::dontSendNotification);

    pads[selectedPad]->repaint();
}

void DrumPadEditor::timerCallback()
{
    for (int i = 0; i < numPads; ++i)
    {
        auto* pad = pads[i];
        const int count = processor.getPadTriggerCount (i);

        if (count != pad->lastTriggerCount)
        {
            pad->lastTriggerCount = count;
            pad->flash = 1.0f;
            pad->repaint();
        }
        else if (pad->flash > 0.01f)
        {
            pad->flash *= 0.8f;
            pad->repaint();
        }
        else if (pad->flash > 0.0f)
        {
            pad->flash = 0.0f;
            pad->repaint();
        }
    }

    const int learning = processor.getLearningPad();
    const int lastNote = processor.getLastNoteReceived();

    if (learning >= 0)
        pads[learning]->repaint();   // keeps the learning outline pulsing

    if (learning != lastLearningPad || lastNote != lastNoteSeen)
    {
        // A note was learned or learning moved on to the next pad.
        if (lastLearningPad >= 0)
            pads[lastLearningPad]->repaint();

        if (learning >= 0 && learning != selectedPad)
            selectPad (learning);
        else
            refreshDetailPanel();

        const bool isLearning = learning >= 0;
        learnButton.setToggleState (isLearning, juce::dontSendNotification);
        learnButton.setButtonText (isLearning ? "Cancel Learn" : "MIDI Learn");

        juce::String status;
        if (isLearning)
            status = "MIDI Learn: press a key or pad on your controller to assign it to Pad " + juce::String (learning + 1) + ".";
        else
            status = "Drag samples from Splice, Finder or the browser onto a pad. Right click a pad for more options.";

        if (lastNote >= 0)
            status += "   Last MIDI note: " + noteName (lastNote) + " (" + juce::String (lastNote) + ")";

        statusLabel.setText (status, juce::dontSendNotification);

        lastLearningPad = learning;
        lastNoteSeen = lastNote;
    }
}

//==============================================================================
void DrumPadEditor::loadFilesStartingAt (int pad, const juce::StringArray& files)
{
    juce::StringArray failed;
    int target = pad;

    for (const auto& path : files)
    {
        if (target >= numPads)
            break;

        const juce::File file (path);

        if (file.isDirectory())
            continue;

        if (processor.loadSampleIntoPad (target, file))
            ++target;
        else
            failed.add (file.getFileName());
    }

    selectPad (pad);

    if (! failed.isEmpty())
        showError ("These files could not be loaded:\n" + failed.joinIntoString ("\n"));
}

bool DrumPadEditor::isBrowserDrag (const juce::DragAndDropTarget::SourceDetails& details) const
{
    return details.description.toString() == browserDragId;
}

void DrumPadEditor::loadFileFromBrowserInto (int pad)
{
    const auto file = browserTree.getSelectedFile();

    if (file.existsAsFile())
        loadFilesStartingAt (pad, { file.getFullPathName() });
}

void DrumPadEditor::fileClicked (const juce::File& file, const juce::MouseEvent&)
{
    if (previewToggle.getToggleState() && file.existsAsFile())
        processor.previewFile (file);
}

void DrumPadEditor::fileDoubleClicked (const juce::File& file)
{
    if (file.existsAsFile())
    {
        loadFilesStartingAt (selectedPad, { file.getFullPathName() });
        processor.auditionPad (selectedPad);
    }
    else if (file.isDirectory())
    {
        setBrowserRoot (file);
    }
}

void DrumPadEditor::setBrowserRoot (const juce::File& folder)
{
    if (! folder.isDirectory())
        return;

    processor.setBrowserFolder (folder);
    browserContents.setDirectory (folder, true, true);
    browserPath.setText (folder.getFullPathName(), juce::dontSendNotification);
    browserPath.setTooltip (folder.getFullPathName());
}

void DrumPadEditor::chooseBrowserFolder()
{
    fileChooser = std::make_unique<juce::FileChooser> ("Choose a sample folder", processor.getBrowserFolder());

    fileChooser->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectDirectories,
                              [this] (const juce::FileChooser& chooser)
                              {
                                  auto result = chooser.getResult();
                                  if (result.isDirectory())
                                      setBrowserRoot (result);
                              });
}

void DrumPadEditor::chooseFileForPad (int pad)
{
    auto start = processor.getPadFile (pad);
    if (! start.existsAsFile())
        start = processor.getBrowserFolder();

    fileChooser = std::make_unique<juce::FileChooser> ("Load a sample into Pad " + juce::String (pad + 1),
                                                       start, DrumPadProcessor::getSupportedWildcard());

    fileChooser->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles
                                | juce::FileBrowserComponent::canSelectMultipleItems,
                              [this, pad] (const juce::FileChooser& chooser)
                              {
                                  juce::StringArray paths;
                                  for (const auto& f : chooser.getResults())
                                      paths.add (f.getFullPathName());

                                  if (! paths.isEmpty())
                                      loadFilesStartingAt (pad, paths);
                              });
}

void DrumPadEditor::showPadMenu (int pad)
{
    juce::PopupMenu menu;
    menu.addItem (1, "Load Sample...");
    menu.addItem (2, "Clear", processor.getPadFile (pad) != juce::File());
    menu.addSeparator();
    menu.addItem (3, "MIDI Learn");

    juce::PopupMenu noteMenu;
    const int current = processor.getPadNote (pad);
    for (int n = 24; n <= 96; ++n)
        noteMenu.addItem (1000 + n, noteName (n) + "  (" + juce::String (n) + ")", true, n == current);
    menu.addSubMenu ("Assign Note", noteMenu);

    menu.showMenuAsync (juce::PopupMenu::Options().withTargetComponent (pads[pad]),
                        [this, pad] (int result)
                        {
                            if (result == 1)           chooseFileForPad (pad);
                            else if (result == 2)      { processor.clearPad (pad); refreshDetailPanel(); }
                            else if (result == 3)      processor.startMidiLearn (pad, false);
                            else if (result >= 1000)   { processor.setPadNote (pad, result - 1000); refreshDetailPanel(); }
                        });
}

void DrumPadEditor::showError (const juce::String& message)
{
    juce::AlertWindow::showMessageBoxAsync (juce::MessageBoxIconType::WarningIcon, "Curate Drum Pad", message);
}
