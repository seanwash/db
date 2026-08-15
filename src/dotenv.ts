import { readFileSync } from "node:fs";

import { DbError } from "./errors.ts";

type ParsedValue = {
  value: string;
  expandable: boolean;
};

export function loadDotenvFiles(
  paths: string[],
  shell: Map<string, string>,
): Map<string, string> {
  const values = new Map<string, string>();

  try {
    for (const path of paths) {
      let text = readFileSync(path, "utf8");
      if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }
      parseDotenv(text, values, shell);
    }
  } catch (error) {
    if (error instanceof DbError) {
      throw new DbError(`could not parse environment configuration from ${paths.join(", ")}`);
    }
    if (error instanceof Error) {
      throw new DbError(`could not read environment configuration: ${error.message}`);
    }
    throw error;
  }

  return values;
}

export function parseDotenv(
  text: string,
  existing: Map<string, string>,
  shell: Map<string, string>,
): void {
  const lines = text.split("\r\n").join("\n").split("\r").join("\n").split("\n");

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("export ")) {
      line = line.slice(7).trimStart();
    }

    const equals = line.indexOf("=");
    if (equals < 1) {
      throw new DbError("invalid dotenv entry");
    }
    const key = line.slice(0, equals).trim();
    if (!isKey(key)) {
      throw new DbError("invalid dotenv key");
    }

    const parsed = parseValue(line.slice(equals + 1));
    const value = parsed.expandable
      ? expandVariables(parsed.value, existing, shell)
      : parsed.value;
    existing.set(key, value);
  }
}

function parseValue(input: string): ParsedValue {
  const value = input.trim();
  if (value === "") {
    return { value: "", expandable: true };
  }

  if (value.startsWith("'")) {
    const closing = value.indexOf("'", 1);
    if (closing < 0 || !validRemainder(value.slice(closing + 1))) {
      throw new DbError("invalid single-quoted value");
    }
    return { value: value.slice(1, closing), expandable: false };
  }

  if (value.startsWith('"')) {
    return parseDoubleQuoted(value);
  }

  return { value: stripUnquotedComment(value), expandable: true };
}

function parseDoubleQuoted(input: string): ParsedValue {
  let output = "";
  let escaped = false;

  for (let index = 1; index < input.length; index += 1) {
    const character = input.charAt(index);
    if (escaped) {
      if (character === "n") output += "\n";
      else if (character === "r") output += "\r";
      else if (character === "t") output += "\t";
      else output += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      if (!validRemainder(input.slice(index + 1))) {
        throw new DbError("invalid double-quoted value");
      }
      return { value: output, expandable: true };
    }
    output += character;
  }

  throw new DbError("unclosed double-quoted value");
}

function stripUnquotedComment(value: string): string {
  let end = value.length;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charAt(index) !== "#") {
      continue;
    }
    if (index === 0 || isWhitespace(value.charAt(index - 1))) {
      end = index;
      break;
    }
  }

  const output = value.slice(0, end).trimEnd();
  for (let index = 0; index < output.length; index += 1) {
    if (isWhitespace(output.charAt(index))) {
      throw new DbError("unquoted whitespace in dotenv value");
    }
  }
  return output;
}

function expandVariables(
  value: string,
  existing: Map<string, string>,
  shell: Map<string, string>,
): string {
  let output = "";
  let index = 0;

  while (index < value.length) {
    if (value.charAt(index) !== "$") {
      output += value.charAt(index);
      index += 1;
      continue;
    }

    const braced = value.charAt(index + 1) === "{";
    const nameStart = braced ? index + 2 : index + 1;
    if (!isKeyStart(value.charAt(nameStart))) {
      output += "$";
      index += 1;
      continue;
    }

    let nameEnd = nameStart + 1;
    while (nameEnd < value.length && isKeyCharacter(value.charAt(nameEnd))) {
      nameEnd += 1;
    }
    if (braced && value.charAt(nameEnd) !== "}") {
      output += "$";
      index += 1;
      continue;
    }

    const name = value.slice(nameStart, nameEnd);
    const replacement = existing.get(name) ?? shell.get(name);
    const originalEnd = braced ? nameEnd + 1 : nameEnd;
    output += replacement ?? value.slice(index, originalEnd);
    index = originalEnd;
  }

  return output;
}

function validRemainder(value: string): boolean {
  const remainder = value.trim();
  return remainder === "" || remainder.startsWith("#");
}

function isKey(value: string): boolean {
  if (value === "" || !isKeyStart(value.charAt(0))) {
    return false;
  }
  for (let index = 1; index < value.length; index += 1) {
    if (!isKeyCharacter(value.charAt(index))) {
      return false;
    }
  }
  return true;
}

function isKeyStart(character: string): boolean {
  if (character === "_") {
    return true;
  }
  const code = character.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isKeyCharacter(character: string): boolean {
  if (isKeyStart(character)) {
    return true;
  }
  const code = character.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t";
}
