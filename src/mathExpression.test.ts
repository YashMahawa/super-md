import { describe, expect, it } from "vitest";
import { compileMathExpression } from "./mathExpression";

describe("safe chart expressions", () => {
  it("evaluates existing Math syntax and slider values", () => {
    const expression = compileMathExpression("a * Math.sin(b * x) + Math.PI");
    expect(expression({ a: 2, b: 1, x: Math.PI / 2 })).toBeCloseTo(2 + Math.PI);
  });

  it("rejects JavaScript access and statements", () => {
    expect(() => compileMathExpression("globalThis.alert(1)")).toThrow();
    expect(() => compileMathExpression("x; process.exit(1)")).toThrow();
    expect(() => compileMathExpression("Math.constructor('return 1')()")).toThrow();
  });

  it("uses finite mathematical operations without running scripts", () => {
    expect(compileMathExpression("pow(x, 2) + sqrt(9)")({ x: 4 })).toBe(19);
    expect(Number.isNaN(compileMathExpression("unknown + 1")({}))).toBe(true);
  });
  it("rejects pathological recursion before parsing", () => {
    expect(() => compileMathExpression("(".repeat(3000) + "x" + ")".repeat(3000))).toThrow();
    expect(() => compileMathExpression("1+".repeat(300) + "1")).toThrow();
  });
  it("uses mathematical unary/exponent precedence and negative exponents",()=>{
    expect(compileMathExpression("-x^2")({x:3})).toBe(-9);
    expect(compileMathExpression("(-x)^2")({x:3})).toBe(9);
    expect(compileMathExpression("2^-2")({})).toBe(.25);
    expect(compileMathExpression("2^3^2")({})).toBe(512);
  });
});
