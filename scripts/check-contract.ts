import SwaggerParser from '@apidevtools/swagger-parser';
import { Ajv } from 'ajv';
import { readFile } from 'node:fs/promises';

await SwaggerParser.validate('contracts/openapi.yaml');
const schemas = JSON.parse(await readFile('contracts/schemas.json', 'utf8'));
const fixtures = JSON.parse(await readFile('contracts/fixtures/responses.json', 'utf8'));
const ajv = new Ajv({ strict: true });
ajv.addSchema(schemas, 'notes');
const event = JSON.parse(await readFile('contracts/fixtures/note-change.json', 'utf8'));
const validateEvent = ajv.compile({ $ref: 'notes#/definitions/NoteChange' });
if (!validateEvent(event)) throw new Error('Invalid NoteChange fixture');
for (const [name, value] of Object.entries(fixtures)) {
  const validate = ajv.compile({ $ref: `notes#/definitions/${name}` });
  if (!validate(value)) throw new Error(`Invalid ${name} fixture: ${ajv.errorsText(validate.errors)}`);
}
console.log('OpenAPI and response fixtures validated.');
