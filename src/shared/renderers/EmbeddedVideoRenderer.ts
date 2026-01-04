// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { VideoFrame } from "../video";
import TabRenderer from "./TabRenderer";

export type EmbeddedVideoRendererCommand = {
  field: string | null;
  fieldAvailable: boolean;
  videoFrames: VideoFrame[];
  currentTime: number | null;
};

export default class EmbeddedVideoRenderer implements TabRenderer {
  private CANVAS: HTMLCanvasElement;
  private CANVAS_CONTEXT: CanvasRenderingContext2D;
  private MESSAGE_OVERLAY: HTMLElement;

  private aspectRatio: number | null = null;
  private decoder: VideoDecoder | null = null;
  private decoderConfig: VideoDecoderConfig | null = null;
  private currentFormat: "h264" | "h265" | null = null;
  private waitingForKeyframe: boolean = true;
  private hasRenderedFrame: boolean = false;

  constructor(root: HTMLElement) {
    this.CANVAS = root.getElementsByTagName("canvas")[0] as HTMLCanvasElement;
    this.CANVAS_CONTEXT = this.CANVAS.getContext("2d")!;
    this.MESSAGE_OVERLAY = root.getElementsByClassName("embedded-video-message")[0] as HTMLElement;

    // Check for WebCodecs support
    if (typeof VideoDecoder === "undefined") {
      this.showMessage("WebCodecs API not supported in this browser");
    }
  }

  private showMessage(message: string): void {
    this.MESSAGE_OVERLAY.innerText = message;
    this.MESSAGE_OVERLAY.hidden = false;
    this.CANVAS.hidden = true;
  }

  private hideMessage(): void {
    this.MESSAGE_OVERLAY.hidden = true;
    this.CANVAS.hidden = false;
  }

  private initDecoder(format: "h264" | "h265"): void {
    // Clean up existing decoder
    if (this.decoder) {
      this.decoder.close();
      this.decoder = null;
    }

    // Check for WebCodecs support
    if (typeof VideoDecoder === "undefined") {
      this.showMessage("WebCodecs API not supported");
      return;
    }

    // Map format to codec string
    const codec = format === "h264" ? "avc1.64001f" : "hev1.1.6.L93.B0";

    // Create decoder configuration
    // For Annex B format, don't provide description - WebCodecs will extract SPS/PPS from the stream
    this.decoderConfig = {
      codec: codec,
      optimizeForLatency: true
    };

    try {
      // Create new decoder
      this.decoder = new VideoDecoder({
        output: (frame) => {
          this.renderFrame(frame);
          frame.close();
        },
        error: (error) => {
          console.error("Video decoder error:", error);
          this.showMessage(`Decoder error: ${error.message}`);
        }
      });

      // Configure decoder
      this.decoder.configure(this.decoderConfig);
      this.currentFormat = format;
      this.waitingForKeyframe = false;
    } catch (error) {
      console.error("Failed to create video decoder:", error);
      this.showMessage(`Failed to initialize decoder: ${error}`);
      this.decoder = null;
    }
  }

  private renderFrame(frame: any): void {
    // Update canvas size to match video frame
    if (this.CANVAS.width !== frame.displayWidth || this.CANVAS.height !== frame.displayHeight) {
      this.CANVAS.width = frame.displayWidth;
      this.CANVAS.height = frame.displayHeight;
      this.aspectRatio = frame.displayWidth / frame.displayHeight;
    }

    // Draw frame to canvas
    this.CANVAS_CONTEXT.drawImage(frame, 0, 0);
    this.hideMessage();
    this.hasRenderedFrame = true;
  }

  private decodeVideoFrame(videoFrame: VideoFrame): void {
    const isKeyframe = this.isKeyFrame(videoFrame.data, videoFrame.format);

    // If format changed, reset everything
    if (this.currentFormat !== videoFrame.format) {
      if (this.decoder) {
        this.decoder.close();
        this.decoder = null;
      }
      this.currentFormat = null;
      this.waitingForKeyframe = true;
      this.hasRenderedFrame = false;
    }

    // Wait for a keyframe to start/restart decoding
    if (this.waitingForKeyframe && !isKeyframe) {
      this.showMessage("Waiting for keyframe...");
      return;
    }

    // Initialize decoder on first keyframe
    if (!this.decoder && isKeyframe) {
      this.initDecoder(videoFrame.format);
    }

    if (!this.decoder) {
      return;
    }

    try {
      // Create EncodedVideoChunk from the Annex B data
      // WebCodecs will automatically extract SPS/PPS from keyframes in Annex B format
      // Note: timestamp is required by WebCodecs but not used for synchronization
      // (we use NetworkTables timestamps for that)
      const chunk = new EncodedVideoChunk({
        type: isKeyframe ? "key" : "delta",
        timestamp: 0,
        data: videoFrame.data
      });

      // Decode the chunk
      this.decoder.decode(chunk);
    } catch (error) {
      console.error("Failed to decode video frame:", error);
      this.showMessage(`Decode error: ${error}`);

      // Reset on decode error - wait for next keyframe
      this.waitingForKeyframe = true;
      if (this.decoder) {
        this.decoder.close();
        this.decoder = null;
      }
    }
  }

  /**
   * Check if the frame data contains a keyframe (IDR/IRAP)
   * This is a simple heuristic based on NAL unit types
   */
  private isKeyFrame(data: Uint8Array, format: "h264" | "h265"): boolean {
    if (format === "h264") {
      // Look for IDR NAL unit (type 5) or SPS (type 7)
      // Annex B format: find start codes and check NAL type
      for (let i = 0; i < data.length - 4; i++) {
        // Look for start code: 0x00 0x00 0x00 0x01 or 0x00 0x00 0x01
        if (data[i] === 0 && data[i + 1] === 0) {
          let nalStart = -1;
          if (data[i + 2] === 0 && data[i + 3] === 1) {
            nalStart = i + 4;
          } else if (data[i + 2] === 1) {
            nalStart = i + 3;
          }

          if (nalStart >= 0 && nalStart < data.length) {
            const nalType = data[nalStart] & 0x1f;
            // Type 5 = IDR, Type 7 = SPS, Type 8 = PPS
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

  getAspectRatio(): number | null {
    return this.aspectRatio;
  }

  render(command: unknown): void {
    if (typeof command !== "object" || command === null) return;

    const cmd = command as EmbeddedVideoRendererCommand;

    // No field selected
    if (!cmd.field) {
      this.showMessage("Drag a Video field here");
      this.hasRenderedFrame = false;
      return;
    }

    // Field not available
    if (!cmd.fieldAvailable) {
      this.showMessage(`Field "${cmd.field}" not found in log`);
      this.hasRenderedFrame = false;
      return;
    }

    // No frames to decode
    if (!cmd.videoFrames || cmd.videoFrames.length === 0) {
      // If we've already rendered a frame, keep showing it (paused state)
      if (this.hasRenderedFrame && cmd.currentTime !== null) {
        return;
      }

      // Otherwise show appropriate message
      if (cmd.currentTime !== null) {
        this.showMessage("No video frame at current timeline position");
      } else {
        this.showMessage("Select a time on the timeline");
      }
      return;
    }

    // Decode all frames sequentially (needed for P-frames to have proper reference frames)
    for (const frame of cmd.videoFrames) {
      this.decodeVideoFrame(frame);
    }
  }

  saveState(): unknown {
    return null;
  }

  restoreState(state: unknown): void {}
}
