type Evaluator = (variables: Record<string, number>) => number;

const functions: Record<string, (...values: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos,
  atan: Math.atan, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, log: Math.log,
  log10: Math.log10, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  min: Math.min, max: Math.max, pow: Math.pow,
};

const tokenPattern = /\s*(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_][A-Za-z_0-9]*|\*\*|[()+*/^%,-])/y;

export function compileMathExpression(source: string): Evaluator {
  const normalized = source.replace(/\bMath\.(PI|E|[A-Za-z_][A-Za-z_0-9]*)/g, (_match, name: string) => name === "PI" ? "pi" : name === "E" ? "e" : name);
  const tokens: string[] = [];
  let offset = 0;
  while (offset < normalized.length) {
    tokenPattern.lastIndex = offset;
    const match = tokenPattern.exec(normalized);
    if (!match) {
      if (/^\s*$/.test(normalized.slice(offset))) break;
      throw new Error(`Unsupported chart expression near ${normalized.slice(offset, offset + 14)}`);
    }
    tokens.push(match[0].trim());
    offset = tokenPattern.lastIndex;
  }
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];
  const requireToken = (expected: string) => { if (take() !== expected) throw new Error(`Expected ${expected} in chart expression`); };

  const parsePrimary = (): Evaluator => {
    const token = take();
    if (!token) throw new Error("Incomplete chart expression");
    if (token === "(") { const expression = parseAdditive(); requireToken(")"); return expression; }
    if (/^(?:\d|\.)/.test(token)) { const value = Number(token); return () => value; }
    if (!/^[A-Za-z_]/.test(token)) throw new Error(`Unexpected ${token} in chart expression`);
    if (peek() === "(") {
      if (!Object.hasOwn(functions, token)) throw new Error(`Unsupported chart function: ${token}`);
      const fn = functions[token];
      take();
      const args: Evaluator[] = [];
      if (peek() !== ")") {
        do { args.push(parseAdditive()); if (peek() !== ",") break; take(); } while (true);
      }
      requireToken(")");
      return (variables) => fn(...args.map((arg) => arg(variables)));
    }
    if (token === "pi") return () => Math.PI;
    if (token === "e") return () => Math.E;
    return (variables) => Object.hasOwn(variables, token) ? variables[token] : Number.NaN;
  };
  const parseUnary = (): Evaluator => {
    if (peek() === "+") { take(); return parseUnary(); }
    if (peek() === "-") { take(); const value = parseUnary(); return (variables) => -value(variables); }
    return parsePrimary();
  };
  const parsePower = (): Evaluator => {
    const left = parseUnary();
    if (peek() === "^" || peek() === "**") { take(); const right = parsePower(); return (variables) => left(variables) ** right(variables); }
    return left;
  };
  const parseMultiplicative = (): Evaluator => {
    let left = parsePower();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const operator = take();
      const previous = left;
      const right = parsePower();
      left = (variables) => operator === "*" ? previous(variables) * right(variables) : operator === "/" ? previous(variables) / right(variables) : previous(variables) % right(variables);
    }
    return left;
  };
  const parseAdditive = (): Evaluator => {
    let left = parseMultiplicative();
    while (peek() === "+" || peek() === "-") {
      const operator = take();
      const previous = left;
      const right = parseMultiplicative();
      left = (variables) => operator === "+" ? previous(variables) + right(variables) : previous(variables) - right(variables);
    }
    return left;
  };
  const expression = parseAdditive();
  if (index !== tokens.length) throw new Error(`Unexpected ${peek()} in chart expression`);
  return expression;
}
