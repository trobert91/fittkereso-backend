export interface ProductSpecMapping {
  key?: string;
  labels: string[];
  listValue?: boolean;
  transformer?: (value: string) => string | undefined;
  toLowerCase?: boolean;
  removeWhiteSpace?: boolean;
}
