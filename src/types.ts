export type Client = "tableplus" | "tablepro";

export type Profile = "default" | "test";

export type Context = {
  cwd: string;
  variables: Map<string, string>;
};
