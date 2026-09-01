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
var safeConversionErrors = Object.freeze({
  CONVERSION_FORMAT_UNSUPPORTED: "The requested output format is not supported.",
  CONVERSION_COMPONENT_UNAVAILABLE: "The required conversion component is unavailable.",
  CONVERSION_INPUT_INVALID: "The input file cannot be converted.",
  CONVERSION_OUTPUT_TOO_LARGE: "The converted output is too large.",
  CONVERSION_TIMEOUT: "The conversion timed out.",
  CONVERSION_CANCELLED: "The conversion was cancelled.",
  CONVERSION_INTERRUPTED: "The conversion was interrupted."
});
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
function errorResult(code) {
  return {
    accepted: false,
    status: "failed",
    error: {
      code,
      message: safeConversionErrors[code]
    }
  };
}
function failedResult(error) {
  if (typeof error !== "object" || error === null) return errorResult("CONVERSION_COMPONENT_UNAVAILABLE");
  try {
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
    if (typeof code === "string" && Object.hasOwn(safeConversionErrors, code)) {
      return errorResult(code);
    }
  } catch {
  }
  return errorResult("CONVERSION_COMPONENT_UNAVAILABLE");
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
      } catch (error) {
        results.push(failedResult(error));
      }
    }
    return { workflow: "\u4E07\u8C61\u8F6C\u6362", results };
  }
});
export {
  index_default as default
};
