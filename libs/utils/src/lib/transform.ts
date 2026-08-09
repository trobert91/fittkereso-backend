import { Expose, TransformFnParams } from 'class-transformer';

/** Exposes all nested objects when strategy is set to `excludeAll` */
export const transfromExposeAll = () => {
  @Expose()
  class ExposeAll {}

  @Expose()
  class ExposeAllMap extends Map<unknown, unknown> {}

  @Expose()
  class ExposeAllSet extends Set<unknown> {}

  const transform = (source: unknown): unknown => {
    if (Array.isArray(source)) {
      return source.map(transform);
    } else if (source instanceof Set) {
      return new ExposeAllSet(Array.from(source).map(transform));
    } else if (source instanceof Map) {
      return new ExposeAllMap(
        Array.from(source.entries()).map(([key, value]) => [
          key,
          transform(value),
        ]),
      );
    } else if (typeof source === 'object' && source !== null) {
      return Object.assign(
        new ExposeAll(),
        Object.fromEntries(
          Object.entries(source).map(([key, value]) => [key, transform(value)]),
        ),
      );
    } else {
      return source;
    }
  };

  return ({ key, obj }: Pick<TransformFnParams, 'key' | 'obj'>) =>
    transform((obj as Record<string, unknown>)[key]);
};
