// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import LoggableType from "../../shared/log/LoggableType";
import { EmbeddedVideoRendererCommand } from "../../shared/renderers/EmbeddedVideoRenderer";
import { grabVideoFrame, getVideoFrameTimestamps, isKeyframeData } from "../../shared/video";
import { createUUID } from "../../shared/util";
import TabController from "./TabController";

type FrameMetadata = {
  timestamp: number;
  isKeyframe: boolean;
};

export default class EmbeddedVideoController implements TabController {
  UUID = createUUID();

  private ROOT: HTMLElement;
  private CONTENT_CONTAINER: HTMLElement;
  private DRAG_HIGHLIGHT: HTMLElement;
  private FIELD_DISPLAY: HTMLElement;
  private CLOSE_BUTTON: HTMLElement;

  private field: string | null = null;
  private frameMetadata: FrameMetadata[] = [];
  private lastRenderedTime: number | null = null;

  constructor(root: HTMLElement) {
    this.ROOT = root;
    this.CONTENT_CONTAINER = root.getElementsByClassName("embedded-video-content")[0] as HTMLElement;
    this.DRAG_HIGHLIGHT = root.getElementsByClassName("embedded-video-drag-highlight")[0] as HTMLElement;
    this.FIELD_DISPLAY = root.getElementsByClassName("embedded-video-field-display")[0] as HTMLElement;
    this.CLOSE_BUTTON = root.getElementsByClassName("embedded-video-close")[0] as HTMLElement;

    // Drag handling
    window.addEventListener("drag-update", (event) => {
      if (this.ROOT.hidden) return;
      let dragData = (event as CustomEvent).detail;
      if (!("fields" in dragData.data)) return;

      let rect = this.CONTENT_CONTAINER.getBoundingClientRect();
      let active =
        dragData.x > rect.left && dragData.x < rect.right && dragData.y > rect.top && dragData.y < rect.bottom;

      // Check if the dragged field is Raw type (video_data)
      let fieldKey = dragData.data.fields[0];
      let fieldType = window.log.getType(fieldKey);
      let validType = fieldType === LoggableType.Raw;

      this.DRAG_HIGHLIGHT.hidden = true;
      if (active && validType) {
        if (dragData.end) {
          this.field = fieldKey;
          this.buildFrameMetadata();
          this.updateFieldDisplay();
        } else {
          this.DRAG_HIGHLIGHT.hidden = false;
        }
      }
    });

    // Close button handler
    this.CLOSE_BUTTON.addEventListener("click", () => {
      this.field = null;
      this.updateFieldDisplay();
    });
  }

  private buildFrameMetadata(): void {
    this.frameMetadata = [];
    this.lastRenderedTime = null;

    if (!this.field) return;

    // Get all timestamps for this video field
    const timestamps = getVideoFrameTimestamps(window.log, this.field);

    // Build metadata for each frame
    for (const timestamp of timestamps) {
      const frame = grabVideoFrame(window.log, this.field, timestamp, this.UUID);
      if (frame) {
        this.frameMetadata.push({
          timestamp: timestamp,
          isKeyframe: isKeyframeData(frame.data, frame.format)
        });
      }
    }
  }

  private findKeyframeBeforeTime(targetTime: number): number {
    // Find the last keyframe at or before targetTime
    for (let i = this.frameMetadata.length - 1; i >= 0; i--) {
      if (this.frameMetadata[i].timestamp <= targetTime && this.frameMetadata[i].isKeyframe) {
        return i;
      }
    }
    return -1;
  }

  private updateFieldDisplay(): void {
    if (this.field !== null) {
      this.FIELD_DISPLAY.innerText = this.field;
      this.FIELD_DISPLAY.hidden = false;
      this.CLOSE_BUTTON.hidden = false;
      this.DRAG_HIGHLIGHT.hidden = true;
    } else {
      this.FIELD_DISPLAY.hidden = true;
      this.CLOSE_BUTTON.hidden = true;
      this.DRAG_HIGHLIGHT.hidden = false;
    }
  }

  saveState(): unknown {
    return {
      field: this.field
    };
  }

  restoreState(state: unknown): void {
    if (typeof state === "object" && state !== null && "field" in state) {
      if (typeof state.field === "string" || state.field === null) {
        this.field = state.field;
        if (this.field) {
          this.buildFrameMetadata();
        }
        this.updateFieldDisplay();
      }
    }
  }

  refresh(): void {
    this.updateFieldDisplay();
  }

  newAssets(): void {}

  getActiveFields(): string[] {
    if (this.field !== null) {
      return [this.field];
    } else {
      return [];
    }
  }

  showTimeline(): boolean {
    return true;
  }

  getCommand(): EmbeddedVideoRendererCommand {
    // Check if field is available
    const isAvailable = this.field !== null && window.log.getFieldKeys().includes(this.field);

    if (!isAvailable) {
      return {
        field: this.field,
        fieldAvailable: false,
        videoFrames: [],
        currentTime: null
      };
    }

    // Get current timeline position
    const selectedTime = window.selection.getSelectedTime();
    if (selectedTime === null) {
      return {
        field: this.field,
        fieldAvailable: true,
        videoFrames: [],
        currentTime: null
      };
    }

    // If time hasn't changed, don't send any frames (avoid re-decoding)
    if (this.lastRenderedTime === selectedTime) {
      return {
        field: this.field,
        fieldAvailable: true,
        videoFrames: [],
        currentTime: selectedTime
      };
    }

    // Find the target frame index
    let targetIndex = -1;
    for (let i = 0; i < this.frameMetadata.length; i++) {
      if (this.frameMetadata[i].timestamp <= selectedTime) {
        targetIndex = i;
      } else {
        break;
      }
    }

    if (targetIndex === -1) {
      return {
        field: this.field,
        fieldAvailable: true,
        videoFrames: [],
        currentTime: selectedTime
      };
    }

    // Determine if we need to seek (time jumped backwards or too far forward)
    const needsSeek =
      this.lastRenderedTime === null ||
      selectedTime < this.lastRenderedTime ||
      selectedTime - this.lastRenderedTime > 2.0; // More than 2 seconds forward

    // Find starting frame
    let startIndex: number;
    if (needsSeek) {
      // Find keyframe before target
      startIndex = this.findKeyframeBeforeTime(selectedTime);
      if (startIndex === -1) {
        // No keyframe found, can't decode
        return {
          field: this.field,
          fieldAvailable: true,
          videoFrames: [],
          currentTime: selectedTime
        };
      }
    } else {
      // Sequential playback - just get frames since last render
      const lastIndex = this.frameMetadata.findIndex((f) => f.timestamp === this.lastRenderedTime);
      startIndex = lastIndex >= 0 ? lastIndex + 1 : targetIndex;
    }

    // Collect all frames from start to target
    const frames = [];
    for (let i = startIndex; i <= targetIndex; i++) {
      const timestamp = this.frameMetadata[i].timestamp;
      const frame = grabVideoFrame(window.log, this.field!, timestamp, this.UUID);
      if (frame) {
        frames.push(frame);
      }
    }

    this.lastRenderedTime = selectedTime;

    return {
      field: this.field,
      fieldAvailable: true,
      videoFrames: frames,
      currentTime: selectedTime
    };
  }
}
