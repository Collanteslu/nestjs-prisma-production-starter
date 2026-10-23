//#region src/types.d.ts
interface UnknownSchema {
  parse(input: unknown, options?: {
    reportInput?: boolean;
    [x: string | number | symbol]: unknown;
  }): unknown;
  encode?(input: unknown, options?: {
    reportInput?: boolean;
    [x: string | number | symbol]: unknown;
  }): unknown;
  array?: () => UnknownSchema;
}
/**
 * RequiredBy
 * @desc From `T` make a set of properties by key `K` become required
 * @example
 *    type Props = {
 *      name?: string;
 *      age?: number;
 *      visible?: boolean;
 *    };
 *
 *    // Expect: { name: string; age: number; visible: boolean; }
 *    type Props = RequiredBy<Props>;
 *
 *    // Expect: { name?: string; age: number; visible: boolean; }
 *    type Props = RequiredBy<Props, 'age' | 'visible'>;
 */
type RequiredBy<T extends object, K extends keyof T = keyof T> = Omit<T, K> & Required<Pick<T, K>>;
//#endregion
//#region src/dto.d.ts
interface ZodDto<TSchema extends UnknownSchema = UnknownSchema, TCodec extends boolean = boolean> {
  new (): ReturnType<TSchema['parse']>;
  isZodDto: true;
  schema: TSchema;
  codec: TCodec;
  create(input: unknown): ReturnType<TSchema['parse']>;
  Output: ZodDto<UnknownSchema, TCodec>;
  _OPENAPI_METADATA_FACTORY(): unknown;
}
declare function createZodDto<TSchema extends UnknownSchema, TCodec extends boolean = false>(schema: TSchema, options?: {
  codec: TCodec;
}): ZodDto<TSchema, TCodec>;
declare function isZodDto(metatype: unknown): metatype is ZodDto<UnknownSchema, boolean>;
//#endregion
export { UnknownSchema as a, RequiredBy as i, createZodDto as n, isZodDto as r, ZodDto as t };