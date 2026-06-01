const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const nextVersion = process.argv[2];

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(nextVersion || "")) {
  console.error("Usage: npm run bump-version -- 1.0.2");
  process.exit(1);
}

const versionCode = Number(nextVersion.split(/[+-]/)[0].replace(/\./g, ""));

updateJson(path.join(ROOT, "package.json"), (json) => {
  json.version = nextVersion;
});

updateJson(path.join(ROOT, "package-lock.json"), (json) => {
  json.version = nextVersion;
  if (json.packages && json.packages[""]) {
    json.packages[""].version = nextVersion;
  }
});

const gradlePath = path.join(ROOT, "app", "build.gradle");
const gradle = fs.readFileSync(gradlePath, "utf8")
  .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
  .replace(/versionName\s+"[^"]+"/, `versionName "${nextVersion}"`);
fs.writeFileSync(gradlePath, gradle);

console.log(`Bumped Windows app and Quest APK to ${nextVersion} (Android versionCode ${versionCode}).`);

function updateJson(filePath, mutate) {
  const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
  mutate(json);
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}
