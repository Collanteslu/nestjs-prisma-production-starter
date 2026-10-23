Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const require_dto = require("./dto-sWxCeI9D.cjs");
let deepmerge = require("deepmerge");
deepmerge = require_dto.__toESM(deepmerge);
let _nestjs_common = require("@nestjs/common");
let rxjs = require("rxjs");
let node_util = require("node:util");
//#region src/exception.ts
var ZodValidationException = class extends _nestjs_common.BadRequestException {
	constructor(error) {
		super({
			statusCode: _nestjs_common.HttpStatus.BAD_REQUEST,
			message: "Validation failed",
			errors: error && typeof error === "object" && "issues" in error ? error.issues : void 0
		});
		this.error = error;
	}
	getZodError() {
		return this.error;
	}
};
var ZodSerializationException = class extends _nestjs_common.InternalServerErrorException {
	constructor(error) {
		super();
		this.error = error;
	}
	getZodError() {
		return this.error;
	}
};
const createZodValidationException = (error) => {
	return new ZodValidationException(error);
};
const createZodSerializationException = (error) => {
	return new ZodSerializationException(error);
};
//#endregion
//#region src/validate.ts
/**
* @deprecated `validate` will be removed in a future version.  It is
* recommended to use `.parse` directly
*/
function validate(value, schemaOrDto, createValidationException = createZodValidationException) {
	const schema = require_dto.isZodDto(schemaOrDto) ? schemaOrDto.schema : schemaOrDto;
	try {
		return schema.parse(value);
	} catch (error) {
		throw createValidationException(error);
	}
}
//#endregion
//#region \0@oxc-project+runtime@0.135.0/helpers/esm/decorateMetadata.js
function __decorateMetadata(k, v) {
	if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
}
//#endregion
//#region \0@oxc-project+runtime@0.135.0/helpers/esm/decorate.js
function __decorate(decorators, target, key, desc) {
	var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
	if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
	else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
	return c > 3 && r && Object.defineProperty(target, key, r), r;
}
//#endregion
//#region src/guard.ts
/**
* @deprecated `createZodGuard` will be removed in a future version, since
* guards are not intended for validation purposes.
*/
function createZodGuard({ createValidationException } = {}) {
	let ZodGuard = class ZodGuard {
		constructor(source, schemaOrDto) {
			this.source = source;
			this.schemaOrDto = schemaOrDto;
		}
		canActivate(context) {
			const data = context.switchToHttp().getRequest()[this.source];
			validate(data, this.schemaOrDto, createValidationException);
			return true;
		}
	};
	ZodGuard = __decorate([(0, _nestjs_common.Injectable)(), __decorateMetadata("design:paramtypes", [Object, Object])], ZodGuard);
	return ZodGuard;
}
/**
* @deprecated `ZodGuard` will be removed in a future version, since guards
* are not intended for validation purposes.
*/
const ZodGuard = createZodGuard();
/**
* @deprecated `UseZodGuard` will be removed in a future version, since guards
* are not intended for validation purposes.
*/
const UseZodGuard = (source, schemaOrDto) => (0, _nestjs_common.UseGuards)(new ZodGuard(source, schemaOrDto));
//#endregion
//#region \0@oxc-project+runtime@0.135.0/helpers/esm/decorateParam.js
function __decorateParam(paramIndex, decorator) {
	return function(target, key) {
		decorator(target, key, paramIndex);
	};
}
//#endregion
//#region src/pipe.ts
var ZodSchemaDeclarationException = class extends _nestjs_common.InternalServerErrorException {
	constructor() {
		super();
	}
};
function createZodValidationPipe({ createValidationException, strictSchemaDeclaration = false } = {}) {
	let ZodValidationPipe = class ZodValidationPipe {
		constructor(schemaOrDto) {
			this.schemaOrDto = schemaOrDto;
		}
		transform(value, metadata) {
			if (this.schemaOrDto) return validate(value, this.schemaOrDto, createValidationException);
			const { metatype } = metadata;
			if (!require_dto.isZodDto(metatype)) {
				if (strictSchemaDeclaration) throw new ZodSchemaDeclarationException();
				return value;
			}
			return validate(value, metatype.schema, createValidationException);
		}
	};
	ZodValidationPipe = __decorate([
		(0, _nestjs_common.Injectable)(),
		__decorateParam(0, (0, _nestjs_common.Optional)()),
		__decorateMetadata("design:paramtypes", [Object])
	], ZodValidationPipe);
	return ZodValidationPipe;
}
const ZodValidationPipe = createZodValidationPipe();
//#endregion
//#region src/serializer.ts
const REFLECTOR = "Reflector";
const ZodSerializerDtoOptions = "ZOD_SERIALIZER_DTO_OPTIONS";
function ZodSerializerDto(dto) {
	if (Array.isArray(dto)) {
		const schema = "schema" in dto[0] ? dto[0].schema : dto[0];
		require_dto.assert("array" in schema && typeof schema.array === "function", "ZodSerializerDto was used with array syntax (e.g. `ZodSerializerDto([MyDto])`) but the DTO schema does not have an array method");
	}
	return (0, _nestjs_common.SetMetadata)(ZodSerializerDtoOptions, dto);
}
function createZodSerializerInterceptor({ reportInput } = {}) {
	let ZodSerializerInterceptor = class ZodSerializerInterceptor {
		constructor(reflector) {
			this.reflector = reflector;
		}
		intercept(context, next) {
			const responseSchema = this.getContextResponseSchema(context);
			return next.handle().pipe((0, rxjs.map)((res) => {
				if (!responseSchema) return res;
				if (res instanceof _nestjs_common.StreamableFile) return res;
				if (Array.isArray(responseSchema)) {
					const schemaOrDto = responseSchema[0];
					const schema = "schema" in schemaOrDto ? schemaOrDto.schema : schemaOrDto;
					require_dto.assert("array" in schema && typeof schema.array === "function", "ZodSerializerDto was used with array syntax (e.g. `ZodSerializerDto([MyDto])`) but the DTO schema does not have an array method");
					const arrSchema = schema.array();
					if (require_dto.isZodDto(schemaOrDto)) {
						if (schemaOrDto.codec) {
							require_dto.assert(arrSchema.encode, "Schema does not have an encode method");
							try {
								return arrSchema.encode(res, reportInput !== void 0 ? { reportInput } : void 0);
							} catch (error) {
								throw createZodSerializationException(error);
							}
						}
						try {
							return arrSchema.parse(res, reportInput !== void 0 ? { reportInput } : void 0);
						} catch (error) {
							throw createZodSerializationException(error);
						}
					}
					try {
						return arrSchema.parse(res, reportInput !== void 0 ? { reportInput } : void 0);
					} catch (error) {
						throw createZodSerializationException(error);
					}
				}
				if (require_dto.isZodDto(responseSchema)) {
					if (responseSchema.codec) {
						require_dto.assert(responseSchema.schema.encode, "Schema does not have an encode method");
						try {
							return responseSchema.schema.encode(res, reportInput !== void 0 ? { reportInput } : void 0);
						} catch (error) {
							throw createZodSerializationException(error);
						}
					}
					try {
						return responseSchema.schema.parse(res, reportInput !== void 0 ? { reportInput } : void 0);
					} catch (error) {
						throw createZodSerializationException(error);
					}
				}
				try {
					return responseSchema.parse(res, reportInput !== void 0 ? { reportInput } : void 0);
				} catch (error) {
					throw createZodSerializationException(error);
				}
			}));
		}
		getContextResponseSchema(context) {
			return this.reflector.getAllAndOverride(ZodSerializerDtoOptions, [context.getHandler(), context.getClass()]);
		}
	};
	ZodSerializerInterceptor = __decorate([
		(0, _nestjs_common.Injectable)(),
		__decorateParam(0, (0, _nestjs_common.Inject)(REFLECTOR)),
		__decorateMetadata("design:paramtypes", [Object])
	], ZodSerializerInterceptor);
	return ZodSerializerInterceptor;
}
const ZodSerializerInterceptor = createZodSerializerInterceptor();
//#endregion
//#region src/cleanupOpenApiDoc.ts
/**
* This function performs some post-processing on the OpenAPI document.  It
* should only touch parts of the document that were generated from nestjs-zod
* DTOs.
*
* Specifically, this function:
* 1. Removes empty `type` fields
* 2. Renames OpenAPI schemas that have an explicit `id` field to match that
*    `id`, instead of using the DTO class name
* 3. If the DTO's schema references another zod schema, it adds that zod
*    schema's OpenAPI representation to `components.schemas`
* 4. If a DTO is created directly with an array zod schema, it ensures the
*    OpenAPI schema is generated properly
* 5. Handles recursive zod schemas
* 6. Handles `null` properly based on the OpenAPI version
*
* @param doc - The OpenAPI document that is generated by `SwaggerModule.createDocument`
* @param options.version - The version of OpenAPI to use.  Defaults to `auto`,
* which will use the version of the OpenAPI object passed in.  Note if the
* version is `3.1` then it impacts how `null` is handled.  In `3.0`, `nullable:
* true` is used, while in `3.1` `anyOf: [..., { type: 'null' }]` is used
* instead
* @returns A cleaned up OpenAPI document
*/
function cleanupOpenApiDoc(doc, { version: versionParam = "auto" } = {}) {
	const schemas = {};
	const renames = {};
	const version = versionParam === "auto" ? doc.openapi.startsWith("3.1") ? "3.1" : "3.0" : versionParam;
	for (const [oldSchemaName, oldOpenapiSchema] of Object.entries(doc.components?.schemas || {})) {
		const { newSchema, newSchemaName, additionalNewSchemas } = cleanupSchema({
			oldSchemaName,
			oldOpenapiSchema,
			version
		});
		for (const [additionalSchemaName, additionalSchema] of Object.entries(additionalNewSchemas)) registerSchema(schemas, additionalSchemaName, additionalSchema);
		if (oldSchemaName !== newSchemaName) renames[oldSchemaName] = newSchemaName;
		registerSchema(schemas, newSchemaName, newSchema);
	}
	const paths = (0, deepmerge.default)(doc.paths, {});
	for (const { get, patch, post, delete: del, put, head } of Object.values(paths)) for (const methodObject of Object.values({
		get,
		patch,
		post,
		del,
		put,
		head
	})) {
		fixRefsInBodies({
			methodObject,
			renames
		});
		for (let i = 0; i < (methodObject?.parameters || []).length; i++) {
			require_dto.assert(methodObject?.parameters, "parameters is required");
			let parameter = methodObject.parameters[i];
			parameter = fixParameter(parameter, version);
			if (require_dto.SELF_REQUIRED_KEY in parameter) {
				if ("schema" in parameter && parameter.in === "query" && typeof parameter.style === "undefined" && parameter.schema && "type" in parameter.schema && parameter.schema.type === "object") parameter.style = "deepObject";
				if ("schema" in parameter) {
					if (Array.isArray(parameter.required) && parameter.schema && "type" in parameter.schema && parameter.schema.type === "object" && typeof parameter.schema.required === "undefined") parameter.schema.required = parameter.required;
					parameter.required = Boolean(parameter[require_dto.SELF_REQUIRED_KEY]);
				}
				delete parameter[require_dto.SELF_REQUIRED_KEY];
			}
			if (require_dto.DEFS_KEY in parameter) {
				const defs = parameter[require_dto.DEFS_KEY];
				delete parameter[require_dto.DEFS_KEY];
				for (const [defSchemaId, defSchema] of Object.entries(defs)) {
					let fixedDef;
					try {
						fixedDef = require_dto.fixAllRefs({ schema: defSchema });
					} catch (err) {
						if (err instanceof Error && err.message.startsWith("[fixAllRefs]")) throw new Error(`[cleanupOpenApiDoc] Recursive schemas are not supported for parameters`, { cause: err });
						throw err;
					}
					if (version === "3.0") fixedDef = require_dto.convertToOpenApi3Point0(fixedDef);
					registerSchema(schemas, defSchemaId, fixedDef);
				}
			}
			methodObject.parameters[i] = parameter;
		}
	}
	return {
		...doc,
		paths,
		components: {
			...doc.components,
			schemas
		}
	};
}
/**
* Registers a schema in the schema registry.
*
* Mutates `schemaRegistry`
*/
function registerSchema(schemaRegistry, schemaName, schema) {
	if (schemaRegistry[schemaName] && !(0, node_util.isDeepStrictEqual)(schemaRegistry[schemaName], schema)) throw new Error(`[cleanupOpenApiDoc] Found multiple schemas with name \`${schemaName}\`.  Please review your schemas to ensure that you are not using the same schema name for different schemas`);
	schemaRegistry[schemaName] = schema;
}
/**
* In the process of cleaning up the OpenAPI document, we may rename schemas.
*
* This function fixes the `$ref` fields in the request body and responses to
* point to the correct schema names.
*
* Mutates `methodObject`
*/
function fixRefsInBodies({ methodObject, renames }) {
	const content = methodObject?.requestBody && "content" in methodObject.requestBody && methodObject.requestBody.content || {};
	for (const requestBodyObject of Object.values(content)) if (requestBodyObject.schema && "$ref" in requestBodyObject.schema) {
		const oldSchemaName = getSchemaNameFromRef(requestBodyObject.schema.$ref);
		if (renames[oldSchemaName]) {
			const newSchemaName = renames[oldSchemaName];
			requestBodyObject.schema.$ref = requestBodyObject.schema.$ref.replace(`/${oldSchemaName}`, `/${newSchemaName}`);
		}
	}
	for (const statusCodeObject of Object.values(methodObject?.responses || {})) {
		const content = statusCodeObject && "content" in statusCodeObject && statusCodeObject.content || {};
		for (const responseBodyObject of Object.values(content)) if (responseBodyObject.schema && "$ref" in responseBodyObject.schema) {
			const oldSchemaName = getSchemaNameFromRef(responseBodyObject.schema.$ref);
			if (renames[oldSchemaName]) {
				const newSchemaName = renames[oldSchemaName];
				responseBodyObject.schema.$ref = responseBodyObject.schema.$ref.replace(`/${oldSchemaName}`, `/${newSchemaName}`);
			}
		}
	}
}
/**
* Cleans up a schema.
*/
function cleanupSchema({ oldSchemaName, oldOpenapiSchema, version }) {
	const additionalNewSchemas = {};
	if (!("type" in oldOpenapiSchema) || oldOpenapiSchema.type !== "object") return {
		newSchema: oldOpenapiSchema,
		newSchemaName: oldSchemaName,
		additionalNewSchemas
	};
	let newSchemaName = oldSchemaName;
	let addedDefs = false;
	let hasRefs = false;
	let usesThreePointOneSyntax = false;
	const defRenames = {};
	let newOpenapiSchema = (0, deepmerge.default)({}, oldOpenapiSchema);
	for (const [propertyName, propertySchema] of Object.entries(newOpenapiSchema.properties || {})) {
		if (require_dto.SELF_REQUIRED_KEY in propertySchema) {
			if (!propertySchema[require_dto.SELF_REQUIRED_KEY] && Array.isArray(newOpenapiSchema.required)) {
				const idx = newOpenapiSchema.required.indexOf(propertyName);
				if (idx !== -1) newOpenapiSchema.required.splice(idx, 1);
				if (newOpenapiSchema.required.length === 0) delete newOpenapiSchema.required;
			}
			delete propertySchema[require_dto.SELF_REQUIRED_KEY];
			if ("selfRequired" in propertySchema) delete propertySchema.selfRequired;
		}
		if (require_dto.USES_THREE_POINT_ONE_SYNTAX_KEY in propertySchema) {
			usesThreePointOneSyntax = Boolean(propertySchema[require_dto.USES_THREE_POINT_ONE_SYNTAX_KEY]);
			delete propertySchema[require_dto.USES_THREE_POINT_ONE_SYNTAX_KEY];
		}
		if (require_dto.PARENT_HAS_REFS_KEY in propertySchema) {
			hasRefs = Boolean(propertySchema[require_dto.PARENT_HAS_REFS_KEY]);
			delete propertySchema[require_dto.PARENT_HAS_REFS_KEY];
		}
		if (require_dto.EMPTY_TYPE_KEY in propertySchema && propertySchema[require_dto.EMPTY_TYPE_KEY]) {
			delete propertySchema[require_dto.EMPTY_TYPE_KEY];
			if ("type" in propertySchema && propertySchema.type === "") delete propertySchema.type;
		}
		if (require_dto.PARENT_ID_KEY in propertySchema && typeof propertySchema[require_dto.PARENT_ID_KEY] === "string") {
			newSchemaName = propertySchema[require_dto.PARENT_ID_KEY];
			delete propertySchema[require_dto.PARENT_ID_KEY];
		}
		if (require_dto.PARENT_METADATA_KEY in propertySchema && typeof propertySchema[require_dto.PARENT_METADATA_KEY] === "object") {
			Object.assign(newOpenapiSchema, propertySchema[require_dto.PARENT_METADATA_KEY]);
			delete propertySchema[require_dto.PARENT_METADATA_KEY];
		}
		if (require_dto.PARENT_ADDITIONAL_PROPERTIES_KEY in propertySchema && typeof propertySchema[require_dto.PARENT_ADDITIONAL_PROPERTIES_KEY] === "boolean") {
			newOpenapiSchema.additionalProperties = propertySchema[require_dto.PARENT_ADDITIONAL_PROPERTIES_KEY];
			delete propertySchema[require_dto.PARENT_ADDITIONAL_PROPERTIES_KEY];
		}
		if (require_dto.DEFS_KEY in propertySchema) {
			const defs = propertySchema[require_dto.DEFS_KEY];
			delete propertySchema[require_dto.DEFS_KEY];
			if (!addedDefs) {
				for (const defSchemaId of Object.keys(defs)) if (defSchemaId.startsWith("__schema")) defRenames[defSchemaId] = `${newSchemaName}${defSchemaId}`;
				for (const [defSchemaId, defSchema] of Object.entries(defs)) {
					let fixedDef = require_dto.fixAllRefs({
						schema: defSchema,
						rootSchemaName: newSchemaName,
						defRenames
					});
					if (version === "3.0") fixedDef = require_dto.convertToOpenApi3Point0(fixedDef);
					registerSchema(additionalNewSchemas, defRenames[defSchemaId] || defSchemaId, fixedDef);
				}
				addedDefs = true;
			}
		}
	}
	if (newSchemaName !== oldSchemaName && "id" in newOpenapiSchema) newOpenapiSchema["id"] = newSchemaName;
	if (hasRefs) newOpenapiSchema = require_dto.fixAllRefs({
		schema: newOpenapiSchema,
		rootSchemaName: newSchemaName,
		defRenames
	});
	if (usesThreePointOneSyntax && version === "3.0") newOpenapiSchema = require_dto.convertToOpenApi3Point0(newOpenapiSchema);
	if (newOpenapiSchema.properties && "root" in newOpenapiSchema.properties && require_dto.UNWRAP_ROOT_KEY in newOpenapiSchema.properties.root) {
		const replaceRoot = newOpenapiSchema.properties.root[require_dto.UNWRAP_ROOT_KEY];
		delete newOpenapiSchema.properties.root[require_dto.UNWRAP_ROOT_KEY];
		if (replaceRoot) newOpenapiSchema = newOpenapiSchema.properties.root;
	}
	if (additionalNewSchemas[newSchemaName] && !(0, node_util.isDeepStrictEqual)(additionalNewSchemas[newSchemaName], newOpenapiSchema)) throw new Error(`[cleanupOpenApiDoc] Found multiple schemas with name \`${newSchemaName}\`.  Please review your schemas to ensure that you are not using the same schema name for different schemas`);
	return {
		newSchema: newOpenapiSchema,
		newSchemaName,
		additionalNewSchemas
	};
}
/**
* Fixes various issues with parameters:
* 1. Removes empty `type` fields
* 2. Moves `const` from the root level of the parameter object to the schema
* 3. Fixes refs to point to components.schemas
* 4. Removes some nestjs-zod markers
*/
function fixParameter(parameterInput, version) {
	const parameter = (0, deepmerge.default)({}, parameterInput);
	let usesThreePointOneSyntax = false;
	if (require_dto.EMPTY_TYPE_KEY in parameter) {
		delete parameter[require_dto.EMPTY_TYPE_KEY];
		if ("schema" in parameter && parameter.schema && "type" in parameter.schema) delete parameter.schema.type;
	}
	if (require_dto.UNWRAP_ROOT_KEY in parameter) throw new Error(`[cleanupOpenApiDoc] Query or url parameters must be an object type`);
	if ("const" in parameter && "schema" in parameter && parameter.schema) {
		Object.assign(parameter.schema, { const: parameter.const });
		delete parameter.const;
	}
	if (require_dto.PARENT_ID_KEY in parameter) delete parameter[require_dto.PARENT_ID_KEY];
	if (require_dto.PARENT_METADATA_KEY in parameter) delete parameter[require_dto.PARENT_METADATA_KEY];
	if (require_dto.PARENT_ADDITIONAL_PROPERTIES_KEY in parameter) delete parameter[require_dto.PARENT_ADDITIONAL_PROPERTIES_KEY];
	if (require_dto.PARENT_HAS_REFS_KEY in parameter) {
		delete parameter[require_dto.PARENT_HAS_REFS_KEY];
		if ("schema" in parameter) try {
			parameter.schema = require_dto.fixAllRefs({ schema: parameter.schema });
		} catch (err) {
			if (err instanceof Error && err.message.startsWith("[fixAllRefs]")) throw new Error(`[cleanupOpenApiDoc] Recursive schemas are not supported for parameters`, { cause: err });
			throw err;
		}
	}
	if (require_dto.USES_THREE_POINT_ONE_SYNTAX_KEY in parameter) {
		usesThreePointOneSyntax = Boolean(parameter[require_dto.USES_THREE_POINT_ONE_SYNTAX_KEY]);
		delete parameter[require_dto.USES_THREE_POINT_ONE_SYNTAX_KEY];
	}
	if (require_dto.PARENT_ADDITIONAL_PROPERTIES_KEY in parameter) delete parameter[require_dto.PARENT_ADDITIONAL_PROPERTIES_KEY];
	if (version === "3.0" && "schema" in parameter && parameter.schema && usesThreePointOneSyntax) parameter.schema = require_dto.convertToOpenApi3Point0(parameter.schema);
	return parameter;
}
function getSchemaNameFromRef(ref) {
	const lastSlash = ref.lastIndexOf("/");
	return ref.slice(lastSlash + 1);
}
//#endregion
//#region src/response.ts
let ApiResponse;
try {
	ApiResponse = require("@nestjs/swagger").ApiResponse;
} catch {}
function ZodResponse({ status, description, type }) {
	require_dto.assert(ApiResponse, "ZodResponse requires @nestjs/swagger to be installed");
	if (Array.isArray(type)) {
		require_dto.assert(type[0][require_dto.ioSymbol] !== "output", "There is no need to use Dto.Output with ZodResponse");
		return (0, _nestjs_common.applyDecorators)(...[
			...status ? [(0, _nestjs_common.HttpCode)(status)] : [],
			ZodSerializerDto(type),
			ApiResponse({
				status,
				description,
				type: [!type[0].codec && "_zod" in type[0].schema ? type[0].Output : type[0]]
			}),
			RequirePassthrough()
		]);
	} else {
		require_dto.assert(type[require_dto.ioSymbol] !== "output", "There is no need to use Dto.Output with ZodResponse");
		return (0, _nestjs_common.applyDecorators)(...[
			...status ? [(0, _nestjs_common.HttpCode)(status)] : [],
			ZodSerializerDto(type),
			ApiResponse({
				status,
				description,
				type: !type.codec && "_zod" in type.schema ? type.Output : type
			}),
			RequirePassthrough()
		]);
	}
}
const ROUTE_ARGS_METADATA = "__routeArguments__";
const RESPONSE_PASSTHROUGH_METADATA = "__responsePassthrough__";
const RESPONSE_PARAMTYPE = "1";
function RequirePassthrough() {
	return (target, propertyKey) => {
		const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, target.constructor, propertyKey) || {};
		if (Object.keys(args).some((key) => key.startsWith(`${RESPONSE_PARAMTYPE}:`))) require_dto.assert(Reflect.getMetadata(RESPONSE_PASSTHROUGH_METADATA, target.constructor, propertyKey) === true, "@ZodResponse requires the passthrough option to be set (e.g. @Res({ passthrough: true })) when using @Res(). Using @Res() without passthrough bypasses the serialization interceptor.");
	};
}
//#endregion
exports.UseZodGuard = UseZodGuard;
exports.ZodGuard = ZodGuard;
exports.ZodResponse = ZodResponse;
exports.ZodSchemaDeclarationException = ZodSchemaDeclarationException;
exports.ZodSerializationException = ZodSerializationException;
exports.ZodSerializerDto = ZodSerializerDto;
exports.ZodSerializerInterceptor = ZodSerializerInterceptor;
exports.ZodValidationException = ZodValidationException;
exports.ZodValidationPipe = ZodValidationPipe;
exports.cleanupOpenApiDoc = cleanupOpenApiDoc;
exports.createZodDto = require_dto.createZodDto;
exports.createZodGuard = createZodGuard;
exports.createZodSerializerInterceptor = createZodSerializerInterceptor;
exports.createZodValidationPipe = createZodValidationPipe;
exports.validate = validate;
exports.zodV3ToOpenAPI = require_dto.zodV3ToOpenAPI;
