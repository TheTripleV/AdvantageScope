// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import Log from "./log/Log";
import { getOrDefault } from "./log/LogUtil";
import LoggableType from "./log/LoggableType";

/**
 * Video frame data structure for field-based video publishing
 * Video is published as two sibling fields:
 *   - video_data: raw bytes (H264/H265 Annex B format)
 *   - video_format: "h264" or "h265" (optional, defaults to "h264")
 */
export type VideoFrame = {
  data: Uint8Array; // compressed video data (H264/H265 Annex B format)
  format: "h264" | "h265"; // codec format
};

/**
 * Get the sibling format key for a video_data field
 * @param dataKey The video_data field key
 * @returns The sibling video_format field key
 */
function getFormatKey(dataKey: string): string {
  // Find the last slash and replace everything after it with "video_format"
  const lastSlash = dataKey.lastIndexOf("/");
  if (lastSlash === -1) {
    return "video_format";
  }
  return dataKey.substring(0, lastSlash) + "/video_format";
}

/**
 * Extract a video frame from the log at the specified timestamp
 * @param log The log instance
 * @param dataKey The video_data field key (e.g., "/vision/camera/video_data")
 * @param timestamp The timestamp to query
 * @param uuid Optional UUID for caching
 * @returns The video frame, or null if no data is available
 */
export function grabVideoFrame(
  log: Log,
  dataKey: string,
  timestamp: number,
  uuid?: string
): VideoFrame | null {
  // Get the raw video data
  const data = getOrDefault(
    log,
    dataKey,
    LoggableType.Raw,
    timestamp,
    new Uint8Array(0),
    uuid
  ) as Uint8Array;

  if (!data || data.length === 0) {
    return null;
  }

  // Get the video format from sibling field, default to h264
  const formatKey = getFormatKey(dataKey);
  const format = getOrDefault(log, formatKey, LoggableType.String, timestamp, "h264", uuid);

  // Validate format (must be h264 or h265)
  const validFormat = format === "h264" || format === "h265" ? format : "h264";

  return {
    data: data,
    format: validFormat as "h264" | "h265"
  };
}

/**
 * Get all video frame timestamps for a given video_data field
 * @param log The log instance
 * @param dataKey The video_data field key
 * @returns Array of timestamps where video frames are available
 */
export function getVideoFrameTimestamps(log: Log, dataKey: string): number[] {
  // Get the full range of video data
  const logRange = log.getTimestampRange();
  if (!logRange) {
    return [];
  }

  const range = log.getRange(dataKey, logRange[0], logRange[1]);
  if (!range || range.timestamps.length === 0) {
    return [];
  }

  return range.timestamps;
}

/**
 * Check if the frame data contains a keyframe (IDR/IRAP)
 * @param data The video frame data
 * @param format The video format
 * @returns true if this is a keyframe
 */
export function isKeyframeData(data: Uint8Array, format: "h264" | "h265"): boolean {
  if (format === "h264") {
    // Look for IDR NAL unit (type 5) or SPS (type 7)
    for (let i = 0; i < data.length - 4; i++) {
      if (data[i] === 0 && data[i + 1] === 0) {
        let nalStart = -1;
        if (data[i + 2] === 0 && data[i + 3] === 1) {
          nalStart = i + 4;
        } else if (data[i + 2] === 1) {
          nalStart = i + 3;
        }

        if (nalStart >= 0 && nalStart < data.length) {
          const nalType = data[nalStart] & 0x1f;
          // Type 5 = IDR, Type 7 = SPS
          if (nalType === 5 || nalType === 7) {
            return true;
          }
        }
      }
    }
  } else if (format === "h265") {
    // Look for IRAP NAL unit or VPS/SPS/PPS
    for (let i = 0; i < data.length - 4; i++) {
      if (data[i] === 0 && data[i + 1] === 0) {
        let nalStart = -1;
        if (data[i + 2] === 0 && data[i + 3] === 1) {
          nalStart = i + 4;
        } else if (data[i + 2] === 1) {
          nalStart = i + 3;
        }

        if (nalStart >= 0 && nalStart < data.length) {
          const nalType = (data[nalStart] >> 1) & 0x3f;
          // Type 32 = VPS, Type 33 = SPS, Type 34 = PPS
          // Types 16-21 = IRAP frames
          if (nalType >= 16 && nalType <= 21) {
            return true;
          }
          if (nalType >= 32 && nalType <= 34) {
            return true;
          }
        }
      }
    }
  }

  return false;
}
