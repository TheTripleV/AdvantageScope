# WPILog Video Field Specification

## Overview

Video support in AdvantageScope allows embedding compressed video frames within WPILog files and NetworkTables streams. This allows robot code to publish camera feeds that can be recorded and played back synchronized with telemetry data.

Video data is published as **two sibling NetworkTables fields**: `video_data` (raw bytes) and optionally `video_format` (string). This approach handles variable-length video data naturally and uses NetworkTables' native timestamp system for synchronization.

## Field Structure

A video stream consists of two sibling fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `video_data` | raw bytes | Yes | Compressed video frame data in Annex B format |
| `video_format` | string | No | Video codec format ("h264" or "h265"), defaults to "h264" |

**Example field structure**:
```
/vision/camera/
  video_data: <raw bytes>
  video_format: "h264"
```

## Field Specifications

### video_format

- **Type**: string
- **Supported Values**:
  - `"h264"` - H.264/AVC codec
  - `"h265"` - H.265/HEVC codec
- **Note**: VP9 and AV1 are not currently supported

### video_data

- **Type**: raw bytes (uint8[])
- **Purpose**: Contains the compressed video frame data
- **Format Requirements**:
  - Must use **Annex B format** (not MP4/AVCC format)
  - Must begin and end on complete NAL unit boundaries (no partial NAL units)
  - Must contain enough NAL units to decode exactly one video frame
  - **No B-frames**: The video stream must not include B-frames (bidirectional predicted frames) as they require lookahead buffering

#### H.264 (AVC) Requirements

When `video_format` is `"h264"`:
- Use Annex B formatted data with start codes (`0x00 0x00 0x00 0x01` or `0x00 0x00 0x01`)
- Each message should contain enough NAL units to decode exactly one video frame
- Messages containing a key frame (IDR - Instantaneous Decoder Refresh) **must** include:
  - SPS (Sequence Parameter Set) NAL unit
  - PPS (Picture Parameter Set) NAL unit
  - IDR slice NAL unit(s)
- Delta frames (P-frames) should only contain slice NAL units

**Example NAL unit sequence for keyframe**:
```
[Start Code][SPS][Start Code][PPS][Start Code][IDR Slice]
```

**Example NAL unit sequence for delta frame**:
```
[Start Code][P-Slice]
```

#### H.265 (HEVC) Requirements

When `video_format` is `"h265"`:
- Use Annex B formatted data with start codes
- Each message should contain enough NAL units to decode exactly one video frame
- Messages containing a key frame (IRAP - Intra Random Access Point) **must** include:
  - VPS (Video Parameter Set) NAL unit
  - SPS (Sequence Parameter Set) NAL unit
  - PPS (Picture Parameter Set) NAL unit
  - IRAP slice NAL unit(s)
- Delta frames should only contain slice NAL units

**Example NAL unit sequence for keyframe**:
```
[Start Code][VPS][Start Code][SPS][Start Code][PPS][Start Code][IRAP Slice]
```

## Usage in WPILog

### Publishing Video Frames

Video frames are published as sibling NetworkTables fields. Each update to `video_data` represents one video frame, with the NetworkTables timestamp used for synchronization. The `video_format` field is optional and defaults to "h264" if not provided.

**Java Example**:
```java
// Get entries for the camera fields
NetworkTableEntry videoDataEntry = NetworkTableInstance.getDefault()
    .getEntry("/vision/camera/video_data");
NetworkTableEntry videoFormatEntry = NetworkTableInstance.getDefault()
    .getEntry("/vision/camera/video_format");

// Publish the format once at initialization (optional, defaults to h264)
videoFormatEntry.setString("h264");

// In periodic callback (e.g., 30 FPS)
public void publishFrame(byte[] h264Data) {
    // Publish the video data - NetworkTables timestamp is used automatically
    videoDataEntry.setRaw(h264Data);
}
```

**C++ Example**:
```cpp
// Get entries for the camera fields
auto videoDataEntry = nt::NetworkTableInstance::GetDefault()
    .GetEntry("/vision/camera/video_data");
auto videoFormatEntry = nt::NetworkTableInstance::GetDefault()
    .GetEntry("/vision/camera/video_format");

// Publish the format once at initialization (optional, defaults to h264)
videoFormatEntry.SetString("h264");

// In periodic callback
void PublishFrame(std::span<const uint8_t> h264Data) {
    // Publish the video data - NetworkTables timestamp is used automatically
    videoDataEntry.SetRaw(h264Data);
}
```

### Recommended Frame Rates

- **Standard**: 15-30 FPS for general viewing
- **Low bandwidth**: 10-15 FPS to reduce log file size
- **High quality**: 30-60 FPS for detailed analysis

### Keyframe Interval

- Include a keyframe (IDR/IRAP) every 1-2 seconds for seekability
- This allows AdvantageScope to seek to any point in the video without decoding from the beginning
- Example: At 30 FPS, send a keyframe every 30-60 frames

## AdvantageScope Integration

### EmbeddedVideo Tab

The EmbeddedVideo tab in AdvantageScope displays video data from WPILog files:

1. **Field Selection**: Drag the `video_data` field (raw bytes) from the sidebar to the tab
2. **Format Detection**: AdvantageScope automatically looks for a sibling `video_format` field, defaulting to "h264" if not found
3. **Timeline Synchronization**: Video playback is synchronized with the log timeline using NetworkTables timestamps
4. **Frame Display**: Frames are decoded and displayed using WebCodecs API
5. **Seeking**: Users can scrub through the timeline to view specific frames

### Type Detection

AdvantageScope accepts any raw bytes field. When a raw field is dragged to the EmbeddedVideo tab, it looks for a sibling `video_format` field to determine the codec. If no `video_format` field exists, it defaults to H.264.

## Limitations and Browser Support

### Codec Support

- **H.264**: Widely supported in all modern browsers
- **H.265**: Support varies by platform:
  - **Windows**: Requires HEVC Video Extension from Microsoft Store
  - **macOS**: Generally supported on Safari and recent Chrome/Edge
  - **Linux**: Support depends on system codecs and browser build

### File Size Considerations

Video data significantly increases log file size:
- **H.264 @ 720p, 30 FPS**: ~1-3 MB per minute
- **H.265 @ 720p, 30 FPS**: ~0.5-2 MB per minute (better compression)
- Consider recording video only during important match periods or using lower resolution/frame rate

### Performance

- Decoding is hardware-accelerated when supported
- Older devices may struggle with high-resolution or high-frame-rate video
- Recommended maximum: 1080p @ 30 FPS

## Comparison with Foxglove MCAP

This specification is inspired by Foxglove's CompressedVideo schema for MCAP but adapted for NetworkTables:

**Similarities**:
- Same Annex B format requirements for H.264/H.265
- Same prohibition on B-frames
- Support for H.264 and H.265 codecs

**Differences**:
- Uses simple NetworkTables fields instead of structured messages (Protobuf/FlatBuffers)
- Uses NetworkTables timestamps instead of separate timestamp field
- No frame_id field (use field path to identify different cameras)
- Does not support VP9 or AV1 (currently)
- Integrates with WPILog timeline instead of ROS time
- Format field is optional, defaults to H.264

## Multiple Cameras

To publish from multiple cameras, use different field paths:

```
/vision/front_camera/video_data: <raw bytes>
/vision/front_camera/video_format: "h264"

/vision/intake_camera/video_data: <raw bytes>
/vision/intake_camera/video_format: "h264"
```

Each `video_data` field can be displayed in a separate EmbeddedVideo tab in AdvantageScope.

## Future Enhancements

Potential future additions:
- VP9 and AV1 codec support
- Camera calibration metadata
- Region of interest (ROI) annotations
- Multiple video quality levels (adaptive streaming)

## References

- [H.264 Annex B Format Specification](https://www.itu.int/rec/T-REC-H.264)
- [H.265 Annex B Format Specification](https://www.itu.int/rec/T-REC-H.265)
- [Foxglove CompressedVideo Schema](https://docs.foxglove.dev/docs/visualization/message-schemas/compressed-video)
- [NetworkTables Documentation](https://docs.wpilib.org/en/stable/docs/software/networktables/networktables-intro.html)
- [WebCodecs API](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API)
