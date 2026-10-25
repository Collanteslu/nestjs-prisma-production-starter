import { Logger } from "@nestjs/common";
import { createAppLogger, nestLogLevels } from "../src/logging";

// ANSI escape sequences start with ESC (0x1b); built from the code point so no raw control
// character (or lint-disabled regex) lives in the source
const ESC = String.fromCharCode(27);

describe("logging", () => {
  describe("nestLogLevels (LOG_LEVEL vocabulary -> Nest levels)", () => {
    it("maps the supported levels and defaults to info", () => {
      expect(nestLogLevels("silent")).toEqual([]);
      expect(nestLogLevels("fatal")).toEqual(["error"]);
      expect(nestLogLevels("warn")).toEqual(["warn", "error"]);
      expect(nestLogLevels(undefined)).toEqual(["log", "warn", "error"]);
      expect(nestLogLevels("nonsense")).toEqual(["log", "warn", "error"]);
      expect(nestLogLevels("trace")).toContain("verbose");
    });
  });

  describe("createAppLogger", () => {
    function capture(fn: () => void): string {
      const chunks: string[] = [];
      const spy = jest.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
      });
      try {
        fn();
      } finally {
        spy.mockRestore();
      }
      return chunks.join("");
    }

    it("writes plain text (no ANSI colours) in production", () => {
      const logger = createAppLogger({ level: "info", production: true });
      const out = capture(() => logger.log("hello", "Test"));
      expect(out).toContain("hello");
      expect(out).not.toContain(ESC);
    });

    it("honours LOG_LEVEL", () => {
      const logger = createAppLogger({ level: "warn", production: true });
      const out = capture(() => {
        logger.log("an info line");
        logger.debug("a debug line");
      });
      expect(out).toBe("");
    });

    it("also drives the static Logger used by the rest of the application", () => {
      Logger.overrideLogger(createAppLogger({ level: "info", production: true }));
      try {
        const out = capture(() => new Logger("Service").warn("careful"));
        expect(out).toContain("careful");
        expect(out).not.toContain(ESC);
      } finally {
        Logger.overrideLogger(new Logger());
      }
    });
  });
});
