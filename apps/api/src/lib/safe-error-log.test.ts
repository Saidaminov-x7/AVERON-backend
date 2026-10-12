import { describe, expect, it } from "vitest";
import { safeErrorLogFields } from "./safe-error-log";

describe("safe error log fields", () => {
  it("keeps only the error type and a constrained internal code", () => {
    const error = Object.assign(new Error("password=do-not-log"), {
      code: "ECONNRESET",
    });
    const fields = safeErrorLogFields(error);

    expect(fields).toEqual({ errorType: "Error", errorCode: "ECONNRESET" });
    expect(JSON.stringify(fields)).not.toContain("password");
    expect(JSON.stringify(fields)).not.toContain(error.message);
  });

  it("omits arbitrary codes and safely handles non-error values", () => {
    expect(
      safeErrorLogFields(
        Object.assign(new Error("secret"), {
          code: "redis://user:secret@host",
        }),
      ),
    ).toEqual({ errorType: "Error" });
    expect(safeErrorLogFields("token=secret")).toEqual({
      errorType: "UnknownError",
    });
  });
});
