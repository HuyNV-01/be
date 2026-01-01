import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

export enum FilterOperator {
  EQ = 'eq',
  NEQ = 'neq',
  GT = 'gt',
  GTE = 'gte',
  LT = 'lt',
  LTE = 'lte',
  LIKE = 'like',
  IN = 'in',
}

export interface FilterMapping {
  [key: string]: string;
}

export function applyFilterToBuilder<T extends ObjectLiteral>(
  builder: SelectQueryBuilder<T>,
  filterString?: string,
  customMapping: FilterMapping = {},
  defaultAlias = 'c',
): SelectQueryBuilder<T> {
  if (!filterString || typeof filterString !== 'string') {
    return builder;
  }

  const rules = filterString.split(',');

  rules.forEach((rule) => {
    const parts = rule.split(':');
    if (parts.length < 3) return;

    const key = parts[0];
    const operator = parts[1] as FilterOperator;

    const value = parts.slice(2).join(':');

    let column: string;
    if (customMapping[key]) {
      column = customMapping[key];
    } else if (key.includes('.')) {
      column = key;
    } else {
      column = `${defaultAlias}.${key}`;
    }

    const paramName = `${key}_${Math.random().toString(36).substring(7)}`;

    switch (operator) {
      case FilterOperator.EQ:
        builder.andWhere(`${column} = :${paramName}`, { [paramName]: value });
        break;
      case FilterOperator.NEQ:
        builder.andWhere(`${column} != :${paramName}`, { [paramName]: value });
        break;
      case FilterOperator.GT:
        builder.andWhere(`${column} > :${paramName}`, { [paramName]: value });
        break;
      case FilterOperator.GTE:
        builder.andWhere(`${column} >= :${paramName}`, { [paramName]: value });
        break;
      case FilterOperator.LT:
        builder.andWhere(`${column} < :${paramName}`, { [paramName]: value });
        break;
      case FilterOperator.LTE:
        builder.andWhere(`${column} <= :${paramName}`, { [paramName]: value });
        break;
      case FilterOperator.LIKE:
        builder.andWhere(`${column} ILIKE :${paramName}`, {
          [paramName]: `%${value}%`,
        });
        break;
      case FilterOperator.IN: {
        const values = value.split('|');
        builder.andWhere(`${column} IN (:...${paramName})`, {
          [paramName]: values,
        });
        break;
      }
      default:
        builder.andWhere(`${column} = :${paramName}`, { [paramName]: value });
    }
  });

  return builder;
}
