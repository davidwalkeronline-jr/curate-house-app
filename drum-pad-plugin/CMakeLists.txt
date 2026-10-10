cmake_minimum_required(VERSION 3.22)

project(CurateDrumPad VERSION 1.0.0)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(APPLE)
    set(CMAKE_OSX_DEPLOYMENT_TARGET "11.0" CACHE STRING "Minimum macOS version")
    set(CMAKE_OSX_ARCHITECTURES "arm64;x86_64" CACHE STRING "Build a universal binary")
endif()

# Use a local JUCE checkout with -DJUCE_DIR=/path/to/JUCE, otherwise download it.
# JUCE 8 ships the AAX SDK inside the framework, so no separate SDK download is needed.
set(JUCE_DIR "" CACHE PATH "Optional path to a local JUCE checkout")

if(JUCE_DIR)
    add_subdirectory(${JUCE_DIR} ${CMAKE_BINARY_DIR}/JUCE)
else()
    include(FetchContent)
    FetchContent_Declare(JUCE
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG 8.0.10
        GIT_SHALLOW TRUE)
    FetchContent_MakeAvailable(JUCE)
endif()

set(DRUMPAD_FORMATS VST3 Standalone)
if(APPLE OR WIN32)
    list(APPEND DRUMPAD_FORMATS AAX)
endif()
if(APPLE)
    list(APPEND DRUMPAD_FORMATS AU)
endif()

juce_add_plugin(CurateDrumPad
    COMPANY_NAME "Curate House"
    COMPANY_WEBSITE "https://curatehouse.com"
    BUNDLE_ID "com.curatehouse.drumpad"
    PLUGIN_MANUFACTURER_CODE Crth
    PLUGIN_CODE CdPd
    PRODUCT_NAME "Curate Drum Pad"
    FORMATS ${DRUMPAD_FORMATS}
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    COPY_PLUGIN_AFTER_BUILD FALSE
    AAX_CATEGORY AAX_ePlugInCategory_SWGenerators
    AU_MAIN_TYPE kAudioUnitType_MusicDevice
    VST3_CATEGORIES Instrument Drum Sampler)

target_sources(CurateDrumPad PRIVATE
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp)

target_compile_definitions(CurateDrumPad PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_USE_MP3AUDIOFORMAT=1
    JUCE_DISPLAY_SPLASH_SCREEN=0)

target_link_libraries(CurateDrumPad
    PRIVATE
        juce::juce_audio_utils
        juce::juce_audio_formats
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)
