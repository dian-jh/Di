import test from "node:test";
import assert from "node:assert/strict";

import { globIsMatch } from "@di/coding-agent";

/**
 *
 * `*` matches any segment within one directory level, `?` one character,
 * `**` crosses directories, and a trailing slash after `**` matches zero or
 * more directory levels (so the double-star pattern also hits root-level .cs
 * files). Paths are matched with `/` separators, everything else is literal.
 */

test("star matches within a directory level only", () => {
  assert.equal(globIsMatch("*.cs", "a.cs", false), true);
  assert.equal(globIsMatch("*.cs", "sub/a.cs", false), false);
  assert.equal(globIsMatch("*.cs", "a.txt", false), false);
});

test("double star crosses directories and also matches root files", () => {
  assert.equal(globIsMatch("**/*.cs", "a.cs", false), true);
  assert.equal(globIsMatch("**/*.cs", "sub/a.cs", false), true);
  assert.equal(globIsMatch("**/*.cs", "a/b/c.cs", false), true);
});

test("concrete prefix star stays within the prefix directory", () => {
  assert.equal(globIsMatch("src/*.cs", "src/a.cs", false), true);
  assert.equal(globIsMatch("src/*.cs", "src/a/b.cs", false), false);
});

test("question mark matches exactly one character", () => {
  assert.equal(globIsMatch("?.cs", "a.cs", false), true);
  assert.equal(globIsMatch("?.cs", "ab.cs", false), false);
});

test("bare double star matches at any depth", () => {
  assert.equal(globIsMatch("**", "any/thing/here.txt", false), true);
});

test("a/**/b matches zero or more middle directories", () => {
  assert.equal(globIsMatch("a/**/b.cs", "a/b.cs", false), true);
  assert.equal(globIsMatch("a/**/b.cs", "a/x/y/b.cs", false), true);
  assert.equal(globIsMatch("a/**/b.cs", "x/b.cs", false), false);
});

test("ignoreCase matches a different case", () => {
  assert.equal(globIsMatch("*.CS", "a.cs", true), true);
  assert.equal(globIsMatch("*.CS", "a.cs", false), false);
});

test("regex special characters are escaped literally", () => {
  assert.equal(globIsMatch("a+b.c", "a+b.c", false), true);
  assert.equal(globIsMatch("a+b.c", "axbxc", false), false);
});

test("windows backslash pattern is normalized to slash", () => {
  assert.equal(globIsMatch("src\\*.cs", "src/a.cs", false, true), true);
  assert.equal(globIsMatch("src\\*.cs", "src/deep/a.cs", false, true), false);
});

test("POSIX backslash pattern character remains literal", () => {
  assert.equal(globIsMatch("literal\\name.txt", "literal\\name.txt", false, false), true);
  assert.equal(globIsMatch("literal\\name.txt", "literal/name.txt", false, false), false);
});

test("double star in the middle of a segment crosses directories", () => {
  assert.equal(globIsMatch("a**b", "ab", false), true);
  assert.equal(globIsMatch("a**b", "a/x/b", false), true);
  assert.equal(globIsMatch("a**b", "acb", false), true);
});

test("empty pattern matches only the empty path", () => {
  assert.equal(globIsMatch("", "", false), true);
  assert.equal(globIsMatch("", "a", false), false);
});

test("brackets are literal, not character classes", () => {
  assert.equal(globIsMatch("a[].c", "a[].c", false), true);
  assert.equal(globIsMatch("a[].c", "a.c", false), false);
});

test("bare double star slash never matches a file", () => {
  assert.equal(globIsMatch("**/", "x/y", false), false);
});

test("question mark can match a dot", () => {
  assert.equal(globIsMatch("?a", ".a", false), true);
});

test("question mark length is exact", () => {
  assert.equal(globIsMatch("?.txt", "a.txt", false), true);
  assert.equal(globIsMatch("?.txt", ".txt", false), false);
  assert.equal(globIsMatch("?.txt", "ab.txt", false), false);
});
