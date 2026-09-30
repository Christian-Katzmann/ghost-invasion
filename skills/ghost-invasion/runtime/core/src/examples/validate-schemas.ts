import { Ajv } from "ajv/dist/ajv.js";
import { schemaExamples } from "./schema-examples.js";
import { versionedSchemas } from "../schemas/index.js";

const ajv = new Ajv({ allErrors: true, strict: false });

let failures = 0;

for (const [name, schema] of Object.entries(versionedSchemas)) {
  const validate = ajv.compile(schema);
  const example = schemaExamples[name as keyof typeof schemaExamples];
  if (!validate(example)) {
    failures += 1;
    console.error(`Schema example failed: ${name}`);
    console.error(validate.errors);
  }
}

const surfaces = [schemaExamples.surface];
const surfaceIds = new Set(surfaces.map((surface) => surface.id));
const routePaths = new Set(surfaces.flatMap((surface) => surface.routes.map((route) => route.path)));
const invariantIds = new Set([schemaExamples.invariant.id]);
const personaIds = new Set([schemaExamples.persona.id]);
const journey = schemaExamples.journey;
const finding = schemaExamples.finding;

for (const route of journey.anchors.routes) {
  if (!routePaths.has(route)) {
    failures += 1;
    console.error(`Journey ${journey.id} anchors unknown route ${route}`);
  }
}

for (const mutation of journey.anchors.mutations) {
  if (!surfaceIds.has(mutation)) {
    failures += 1;
    console.error(`Journey ${journey.id} anchors unknown surface ${mutation}`);
  }
}

for (const persona of journey.appliesToPersonas) {
  if (!personaIds.has(persona)) {
    failures += 1;
    console.error(`Journey ${journey.id} references unknown persona ${persona}`);
  }
}

for (const invariant of journey.invariantsTested) {
  if (!invariantIds.has(invariant)) {
    failures += 1;
    console.error(`Journey ${journey.id} references unknown invariant ${invariant}`);
  }
}

if (!surfaceIds.has(finding.affected.surfaceId)) {
  failures += 1;
  console.error(`Finding ${finding.id} references unknown surface ${finding.affected.surfaceId}`);
}

if (!invariantIds.has(finding.invariant)) {
  failures += 1;
  console.error(`Finding ${finding.id} references unknown invariant ${finding.invariant}`);
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log(`Validated ${Object.keys(schemaExamples).length} schema examples and cross-reference coherence checks.`);
}
