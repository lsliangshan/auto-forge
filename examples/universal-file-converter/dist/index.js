// src/index.ts
import { defineWorkflow } from "@autoforge/workflow-sdk";
var targetFormats = /* @__PURE__ */ new Set([
  "png",
  "jpeg",
  "webp",
  "avif",
  "tiff",
  "bmp",
  "gif",
  "ico",
  "icns",
  "pdf",
  "docx",
  "xlsx",
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
  "mp4",
  "webm",
  "mov"
]);
var presets = /* @__PURE__ */ new Set(["default", "favicon", "app-icon"]);
function validateInput(input) {
  if (!Array.isArray(input.files) || input.files.length === 0 || input.files.length > 5) {
    throw new Error("files must contain between one and five attachment indexes");
  }
  if (input.files.some((index) => !Number.isInteger(index) || index < 0) || new Set(input.files).size !== input.files.length) {
    throw new Error("files must contain unique non-negative attachment indexes");
  }
  if (!targetFormats.has(input.targetFormat)) throw new Error("targetFormat is not supported");
  if (input.preset !== void 0 && !presets.has(input.preset)) throw new Error("preset is not supported");
  if (input.background !== void 0 && typeof input.background !== "boolean") throw new Error("background must be a boolean");
}
function unavailableResult() {
  return {
    accepted: false,
    status: "failed",
    error: {
      code: "CONVERSION_COMPONENT_UNAVAILABLE",
      message: "The conversion component is unavailable."
    }
  };
}
var index_default = defineWorkflow({
  async run(ctx, input) {
    validateInput(input);
    const results = [];
    for (const attachmentIndex of input.files) {
      try {
        results.push(await ctx.converter.submit({
          attachmentIndex,
          targetFormat: input.targetFormat,
          preset: input.preset,
          background: input.background
        }));
      } catch {
        results.push(unavailableResult());
      }
    }
    return { workflow: "\u4E07\u8C61\u8F6C\u6362", results };
  }
});
export {
  index_default as default
};
