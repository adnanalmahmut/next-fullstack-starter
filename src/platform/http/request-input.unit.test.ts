import { describe, expect, it } from "vitest";

import { ValidationError } from "@/shared/errors/application-error";

import { readJsonBody, toQueryRecord } from "./request-input";

describe("toQueryRecord", () => {
  it("reads a single occurrence as a string", () => {
    expect({
      ...toQueryRecord(new URLSearchParams("limit=10&sortBy=email")),
    }).toEqual({ limit: "10", sortBy: "email" });
  });

  it("keeps every value of a repeated key", () => {
    expect({
      ...toQueryRecord(new URLSearchParams("role=a&role=b&role=c")),
    }).toEqual({ role: ["a", "b", "c"] });
  });

  it("keeps a repeated key alongside a single one", () => {
    expect({
      ...toQueryRecord(new URLSearchParams("role=a&role=b&limit=10")),
    }).toEqual({ role: ["a", "b"], limit: "10" });
  });

  it("keeps an empty value rather than dropping the key", () => {
    expect({ ...toQueryRecord(new URLSearchParams("search=")) }).toEqual({
      search: "",
    });
  });

  it("produces an empty record for no parameters", () => {
    expect({ ...toQueryRecord(new URLSearchParams()) }).toEqual({});
  });

  it("treats a prototype-shaped key as ordinary data", () => {
    const record = toQueryRecord(new URLSearchParams("__proto__=polluted"));

    expect(Object.getPrototypeOf(record)).toBeNull();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(record["__proto__"]).toBe("polluted");
  });
});

describe("readJsonBody", () => {
  function request(body: BodyInit | null): Request {
    return new Request("http://localhost/api/v1/probe", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
  }

  it("reads a JSON body", async () => {
    await expect(readJsonBody(request('{"role":"admin"}'))).resolves.toEqual({
      role: "admin",
    });
  });

  it("refuses malformed JSON without echoing it", async () => {
    await expect(readJsonBody(request("{not json"))).rejects.toThrow(
      ValidationError,
    );

    await expect(readJsonBody(request("{not json"))).rejects.toThrow(
      /not acceptable/,
    );
  });

  it("refuses an absent body", async () => {
    await expect(readJsonBody(request(null))).rejects.toThrow(ValidationError);
  });
});
