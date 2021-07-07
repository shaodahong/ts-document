const path = require("path");
const { generate } = require("../lib");

const schema = generate(path.resolve(__dirname, "demo.tsx"), {
  sourceFilesPaths: ["examples/**/*.ts", "examples/**/*.tsx"],
});

console.log(JSON.stringify(schema, null, 2));
