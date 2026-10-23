import { globalRegistry, toJSONSchema } from "zod/v4/core";
import deepmerge from "deepmerge";
import { z } from "zod/v3";
//#region src/assert.ts
function assert(condition, message = "Assertion failed") {
	if (!condition) throw new Error(`[nestjs-zod] ${message}`);
}
//#endregion
//#region src/const.ts
const PREFIX = "x-nestjs_zod";
const EMPTY_TYPE_KEY = `${PREFIX}-empty-type`;
const DEFS_KEY = `${PREFIX}-$defs`;
const PARENT_ID_KEY = `${PREFIX}-parent-id`;
const PARENT_ADDITIONAL_PROPERTIES_KEY = `${PREFIX}-parent-additional-properties`;
const PARENT_HAS_REFS_KEY = `${PREFIX}-parent-has-refs`;
const UNWRAP_ROOT_KEY = `${PREFIX}-unwrap-root`;
const USES_THREE_POINT_ONE_SYNTAX_KEY = `${PREFIX}-uses-3-point-1-syntax`;
const SELF_REQUIRED_KEY = `${PREFIX}-self-required`;
const PARENT_METADATA_KEY = `${PREFIX}-parent-metadata`;
//#endregion
//#region src/utils.ts
function fixAllRefs({ schema, defRenames, rootSchemaName }) {
	return walkJsonSchema(schema, (s) => {
		if (s.$ref) {
			if (s.$ref.startsWith("#/$defs/")) {
				const oldDefName = s.$ref.replace("#/$defs/", "");
				const newDefName = defRenames?.[oldDefName];
				if (newDefName) s.$ref = `#/$defs/${newDefName}`;
			}
			s.$ref = s.$ref.replace("#/$defs/", "#/components/schemas/");
			if (s.$ref === "#") {
				if (!rootSchemaName) throw new Error("[fixAllRefs] rootSchemaName is required when fixing a ref to #");
				s.$ref = `#/components/schemas/${rootSchemaName}`;
			}
		}
		return s;
	}, { clone: true });
}
/**
* By default, zod generates openapi schemas that are compatible with OpenAPI
* 3.1.  But OpenAPI 3.0 supports a weird flavour of JSONSchema they call the
* "subset superset"
*
* This function converts the schema to the OpenAPI 3.0 subset superset format.
*
* See more information here:
* https://www.apimatic.io/blog/2021/09/migrating-to-and-from-openapi-3-1
*/
function convertToOpenApi3Point0(schema) {
	return walkJsonSchema(schema, (s) => {
		if ("id" in s) delete s.id;
		if (s.anyOf) {
			const nullSchema = s.anyOf.findIndex((subSchema) => subSchema.type === "null");
			if (nullSchema === -1) return s;
			s.anyOf.splice(nullSchema, 1);
			const { anyOf, ...rest } = s;
			if (anyOf.length === 1) {
				const sole = anyOf[0];
				if (sole.$ref && Object.keys(sole).length === 1) return {
					allOf: [sole],
					nullable: true,
					...rest
				};
				const enumValues = Array.isArray(sole.enum) ? sole.enum : void 0;
				return {
					...sole,
					...rest,
					...enumValues && !enumValues.includes(null) && { enum: [...enumValues, null] },
					nullable: true
				};
			}
			return {
				...rest,
				anyOf,
				nullable: true
			};
		}
		if (typeof s.const !== "undefined") {
			s.enum = [s.const];
			delete s.const;
		}
		if ("propertyNames" in s) delete s.propertyNames;
		if (typeof s.exclusiveMinimum === "number") {
			s.minimum = s.exclusiveMinimum;
			s.exclusiveMinimum = true;
		}
		if (typeof s.exclusiveMaximum === "number") {
			s.maximum = s.exclusiveMaximum;
			s.exclusiveMaximum = true;
		}
		return s;
	}, { clone: true });
}
function walkJsonSchema(schema, callback, options) {
	schema = callback(options?.clone ? deepmerge(schema, {}) : schema);
	if (schema.type === "object" && schema.properties) for (const key in schema.properties) schema.properties[key] = walkJsonSchema(schema.properties[key], callback);
	if (schema.type === "array" && Array.isArray(schema.items)) schema.items = schema.items.map((item) => walkJsonSchema(item, callback));
	if (schema.type === "array" && schema.items) schema.items = walkJsonSchema(schema.items, callback);
	if (schema.oneOf) schema.oneOf = schema.oneOf.map((subSchema) => walkJsonSchema(subSchema, callback));
	if (schema.anyOf) schema.anyOf = schema.anyOf.map((subSchema) => walkJsonSchema(subSchema, callback));
	if (schema.allOf) schema.allOf = schema.allOf.map((subSchema) => walkJsonSchema(subSchema, callback));
	if (typeof schema.additionalProperties === "object") schema.additionalProperties = walkJsonSchema(schema.additionalProperties, callback);
	if (typeof schema.propertyNames === "object" && schema.propertyNames !== null) schema.propertyNames = walkJsonSchema(schema.propertyNames, callback);
	return schema;
}
//#endregion
//#region src/zodV3ToOpenApi.ts
function is(input, factory) {
	return factory === z[input._def.typeName];
}
/**
* @deprecated `zodToOpenAPI` will be removed in a future version, since zod
* v4 adds built-in support for generating OpenAPI schemas from zod schemas.
*/
function zodV3ToOpenAPI(zodType, visited = /* @__PURE__ */ new Set()) {
	const object = {};
	if (zodType.description) object.description = zodType.description;
	if (is(zodType, z.ZodString)) {
		const { checks } = zodType._def;
		object.type = "string";
		for (const check of checks) if (check.kind === "min") object.minLength = check.value;
		else if (check.kind === "max") object.maxLength = check.value;
		else if (check.kind === "email") object.format = "email";
		else if (check.kind === "url") object.format = "uri";
		else if (check.kind === "uuid") object.format = "uuid";
		else if (check.kind === "cuid") object.format = "cuid";
		else if (check.kind === "regex") object.pattern = check.regex.source;
		else if (check.kind === "datetime") object.format = "date-time";
	}
	if (is(zodType, z.ZodBoolean)) object.type = "boolean";
	if (is(zodType, z.ZodNumber)) {
		const { checks } = zodType._def;
		object.type = "number";
		for (const check of checks) if (check.kind === "int") object.type = "integer";
		else if (check.kind === "min") {
			object.minimum = check.value;
			object.exclusiveMinimum = !check.inclusive;
		} else if (check.kind === "max") {
			object.maximum = check.value;
			object.exclusiveMaximum = !check.inclusive;
		} else if (check.kind === "multipleOf") object.multipleOf = check.value;
	}
	if (is(zodType, z.ZodBigInt)) {
		object.type = "integer";
		object.format = "int64";
	}
	if (is(zodType, z.ZodArray)) {
		const { minLength, maxLength, type } = zodType._def;
		object.type = "array";
		if (minLength) object.minItems = minLength.value;
		if (maxLength) object.maxItems = maxLength.value;
		object.items = zodV3ToOpenAPI(type, visited);
	}
	if (is(zodType, z.ZodTuple)) {
		const { items } = zodType._def;
		object.type = "array";
		object.items = { oneOf: items.map((item) => zodV3ToOpenAPI(item, visited)) };
	}
	if (is(zodType, z.ZodSet)) {
		const { valueType, minSize, maxSize } = zodType._def;
		object.type = "array";
		if (minSize) object.minItems = minSize.value;
		if (maxSize) object.maxItems = maxSize.value;
		object.items = zodV3ToOpenAPI(valueType, visited);
		object.uniqueItems = true;
	}
	if (is(zodType, z.ZodUnion)) {
		const { options } = zodType._def;
		object.oneOf = options.map((option) => zodV3ToOpenAPI(option, visited));
	}
	if (is(zodType, z.ZodDiscriminatedUnion)) {
		const { options } = zodType._def;
		object.oneOf = [];
		for (const schema of options.values()) object.oneOf.push(zodV3ToOpenAPI(schema, visited));
	}
	if (is(zodType, z.ZodLiteral)) {
		const { value } = zodType._def;
		if (typeof value === "string") {
			object.type = "string";
			object.enum = [value];
		}
		if (typeof value === "number") {
			object.type = "number";
			object.minimum = value;
			object.maximum = value;
		}
		if (typeof value === "boolean") object.type = "boolean";
	}
	if (is(zodType, z.ZodEnum)) {
		const { values } = zodType._def;
		object.type = "string";
		object.enum = values;
	}
	if (is(zodType, z.ZodNativeEnum)) {
		const { values } = zodType._def;
		object.type = "string";
		object.enum = Object.values(values);
		object["x-enumNames"] = Object.keys(values);
	}
	if (is(zodType, z.ZodTransformer)) {
		const { schema } = zodType._def;
		Object.assign(object, zodV3ToOpenAPI(schema, visited));
	}
	if (is(zodType, z.ZodNullable)) {
		const { innerType } = zodType._def;
		Object.assign(object, zodV3ToOpenAPI(innerType, visited));
		object.nullable = true;
	}
	if (is(zodType, z.ZodOptional)) {
		const { innerType } = zodType._def;
		Object.assign(object, zodV3ToOpenAPI(innerType, visited));
	}
	if (is(zodType, z.ZodDefault)) {
		const { defaultValue, innerType } = zodType._def;
		Object.assign(object, zodV3ToOpenAPI(innerType, visited));
		object.default = defaultValue();
	}
	if (is(zodType, z.ZodObject)) {
		const { shape } = zodType._def;
		object.type = "object";
		object.properties = {};
		object.required = [];
		for (const [key, schema] of Object.entries(shape())) {
			object.properties[key] = zodV3ToOpenAPI(schema, visited);
			if (![z.ZodOptional.name, z.ZodDefault.name].includes(schema.constructor.name)) object.required.push(key);
		}
		if (object.required.length === 0) delete object.required;
	}
	if (is(zodType, z.ZodRecord)) {
		const { valueType } = zodType._def;
		object.type = "object";
		object.additionalProperties = zodV3ToOpenAPI(valueType, visited);
	}
	if (is(zodType, z.ZodIntersection)) {
		const { left, right } = zodType._def;
		const merged = deepmerge(zodV3ToOpenAPI(left, visited), zodV3ToOpenAPI(right, visited), { arrayMerge: (target, source) => {
			const mergedSet = new Set([...target, ...source]);
			return Array.from(mergedSet);
		} });
		Object.assign(object, merged);
	}
	if (is(zodType, z.ZodEffects)) {
		const { schema } = zodType._def;
		Object.assign(object, zodV3ToOpenAPI(schema, visited));
	}
	if (is(zodType, z.ZodLazy)) {
		const { getter } = zodType._def;
		if (visited.has(getter)) return object;
		visited.add(getter);
		Object.assign(object, zodV3ToOpenAPI(getter(), visited));
	}
	return object;
}
//#endregion
//#region src/symbols.ts
const ioSymbol = Symbol("io");
//#endregion
//#region src/dto.ts
function createZodDto(schema, options) {
	class AugmentedZodDto {
		static {
			this.isZodDto = true;
		}
		static {
			this.schema = schema;
		}
		static {
			this.codec = options?.codec || false;
		}
		static {
			this[ioSymbol] = "input";
		}
		static create(input) {
			return this.schema.parse(input);
		}
		static get Output() {
			assert("_zod" in schema, "Output DTOs can only be created from zod v4 schemas");
			class AugmentedZodDto {
				static {
					this.isZodDto = true;
				}
				static {
					this.schema = schema;
				}
				static {
					this[ioSymbol] = "output";
				}
				static create(input) {
					return this.schema.parse(input);
				}
				static _OPENAPI_METADATA_FACTORY() {
					return openApiMetadataFactory({
						schema: this.schema,
						io: "output"
					});
				}
			}
			Object.defineProperty(AugmentedZodDto, "name", { value: `${this.name}_Output` });
			return AugmentedZodDto;
		}
		static _OPENAPI_METADATA_FACTORY() {
			return openApiMetadataFactory({
				schema: this.schema,
				io: "input"
			});
		}
	}
	return AugmentedZodDto;
}
function openApiMetadataFactory({ schema, io }) {
	if (!("_zod" in schema) && "_def" in schema && io === "output") throw new Error("[nestjs-zod] Output schemas are not supported for zod@v3");
	if (!("_zod" in schema) && !("_def" in schema)) return {};
	const { $defs, $schema: _$schema, ...generatedJsonSchema } = generateJsonSchema(schema, io);
	const zodId = "_zod" in schema ? globalRegistry.get(schema)?.id : void 0;
	const rootId = zodId && io === "output" ? `${zodId}_Output` : zodId;
	/**
	* nestjs expects us to return a record of properties
	*
	* However, in some cases, we can't return a record of properties.  For
	* example, arrays, intersections, and unions can not be represented like this
	*
	* As a workaround, we wrap the schema in a "root" object.  Then in the
	* `cleanupOpenApiDoc` function, we unwrap the root object.
	*/
	const jsonSchema = !isObjectTypeWithProperties(generatedJsonSchema) ? {
		type: "object",
		title: generatedJsonSchema.title,
		properties: { root: {
			...generatedJsonSchema,
			[UNWRAP_ROOT_KEY]: true
		} },
		$defs
	} : {
		...generatedJsonSchema,
		$defs
	};
	const { hasRefs, usesThreePointOneSyntax } = getSchemaMetadata(jsonSchema);
	const properties = {};
	for (const [propertyKey, propertySchema] of Object.entries(jsonSchema.properties || {})) {
		const newPropertySchema = {
			...propertySchema,
			type: propertySchema.type || ""
		};
		if (usesThreePointOneSyntax) newPropertySchema[USES_THREE_POINT_ONE_SYNTAX_KEY] = true;
		if (hasRefs) newPropertySchema[PARENT_HAS_REFS_KEY] = true;
		if (typeof propertySchema.type !== "string") newPropertySchema[EMPTY_TYPE_KEY] = true;
		const required = Boolean("required" in jsonSchema && jsonSchema.required?.includes(propertyKey));
		if (newPropertySchema.type === "object") {
			newPropertySchema.selfRequired = required;
			newPropertySchema[SELF_REQUIRED_KEY] = required;
		} else newPropertySchema.required = required;
		if (jsonSchema.$defs) newPropertySchema[DEFS_KEY] = jsonSchema.$defs;
		if (rootId) newPropertySchema[PARENT_ID_KEY] = rootId;
		if (typeof jsonSchema.additionalProperties === "boolean") newPropertySchema[PARENT_ADDITIONAL_PROPERTIES_KEY] = jsonSchema.additionalProperties;
		const reservedKeys = new Set([
			"type",
			"properties",
			"required",
			"additionalProperties",
			"$defs",
			"id"
		]);
		const parentMetadata = {};
		for (const [key, value] of Object.entries(jsonSchema)) if (!reservedKeys.has(key) && value !== void 0) parentMetadata[key] = value;
		if (Object.keys(parentMetadata).length > 0) newPropertySchema[PARENT_METADATA_KEY] = parentMetadata;
		properties[propertyKey] = newPropertySchema;
	}
	return properties;
}
function generateJsonSchema(schema, io) {
	const generatedJsonSchema = "_zod" in schema ? toJSONSchema(schema, { io }) : zodV3ToOpenAPI(schema);
	const $defs = "$defs" in generatedJsonSchema && generatedJsonSchema.$defs ? generatedJsonSchema.$defs : void 0;
	const newSchema = cleanupRefs(generatedJsonSchema, io);
	const newDefs = {};
	Object.entries($defs || {}).forEach(([defKey, defValue]) => {
		const newKey = io === "output" ? `${defKey}_Output` : defKey;
		if (newDefs[newKey]) throw new Error(`[nestjs-zod] Duplicate id in $defs: ${newKey}`);
		newDefs[newKey] = cleanupRefs(defValue, io);
	});
	if ($defs) newSchema.$defs = newDefs;
	return newSchema;
}
/**
* Suffixes refs with `_Output` if `io` is `output`
*
* Also removes the `id` field from the schema, since this is not a valid
* openapi field.  Some earlier versions of zod 4 included `id`
*/
function cleanupRefs(rootSchema, io) {
	return walkJsonSchema(rootSchema, (schema) => {
		if (schema.$ref && schema.$ref.startsWith("#/$defs/")) {
			const defKey = schema.$ref.replace("#/$defs/", "");
			if (defKey && io === "output") schema.$ref = `#/$defs/${defKey}_Output`;
		}
		if ("id" in schema) delete schema["id"];
		return schema;
	}, { clone: true });
}
function getSchemaMetadata(jsonSchema) {
	let hasRefs = false;
	let usesThreePointOneSyntax = false;
	walkJsonSchema(jsonSchema, (schema) => {
		if (schema.type === "null" || schema.const || schema.id || "propertyNames" in schema || typeof schema.exclusiveMinimum === "number" || typeof schema.exclusiveMaximum === "number") usesThreePointOneSyntax = true;
		if (schema.$ref) hasRefs = true;
		return schema;
	});
	return {
		hasRefs,
		usesThreePointOneSyntax
	};
}
function isZodDto(metatype) {
	return Boolean(metatype && (typeof metatype === "object" || typeof metatype === "function") && "isZodDto" in metatype && metatype.isZodDto);
}
function isObjectTypeWithProperties(jsonSchema) {
	return jsonSchema.type === "object" && !!jsonSchema.properties && Object.keys(jsonSchema.properties).length > 0;
}
//#endregion
export { convertToOpenApi3Point0 as a, EMPTY_TYPE_KEY as c, PARENT_ID_KEY as d, PARENT_METADATA_KEY as f, assert as g, USES_THREE_POINT_ONE_SYNTAX_KEY as h, zodV3ToOpenAPI as i, PARENT_ADDITIONAL_PROPERTIES_KEY as l, UNWRAP_ROOT_KEY as m, isZodDto as n, fixAllRefs as o, SELF_REQUIRED_KEY as p, ioSymbol as r, DEFS_KEY as s, createZodDto as t, PARENT_HAS_REFS_KEY as u };
