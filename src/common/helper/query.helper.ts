/* eslint-disable @typescript-eslint/no-unused-expressions */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Logger } from '@nestjs/common';

import { Brackets, EntityTarget, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

// --- Interfaces ---
export interface PaginationOptions {
  page?: number | string;
  limit?: number | string;
  sort?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export interface ComplexMapConfig<T> {
  mapTo: keyof T | string;
  entity: EntityTarget<any>;
  alias: string;
  conditionBuilder: (
    subQuery: SelectQueryBuilder<any>,
    parentAlias: string,
  ) => SelectQueryBuilder<any>;
  extraCondition?: string;
  params?: ObjectLiteral;
}

/**
 * JsonSubQueryBuilder
 */
export class JsonSubQueryBuilder<T extends ObjectLiteral> {
  private jsonFields: string[] = [];
  private whereConditions: { str: string; params?: ObjectLiteral }[] = [];
  private joins: ((qb: SelectQueryBuilder<any>) => void)[] = [];
  private orderBys: { sort: string; order: 'ASC' | 'DESC' }[] = [];
  private limitNum?: number;

  constructor(
    private entity: EntityTarget<T>,
    private alias: string,
    private parentAlias: string,
  ) {}

  select(fields: string | string[] | { field: string; alias: string }, alias?: string): this {
    if (Array.isArray(fields)) {
      fields.forEach((f) => this.select(f));
      return this;
    }

    let colStr = '';
    let keyStr = '';

    if (typeof fields === 'string') {
      colStr = fields.includes('.') ? fields : `${this.alias}.${fields}`;
      keyStr = alias || (fields.includes('.') ? fields.split('.')[1] : fields);
    } else {
      colStr = fields.field;
      keyStr = fields.alias;
    }
    this.jsonFields.push(`'${keyStr}', ${colStr}`);
    return this;
  }

  selectRaw(expression: string, alias: string): this {
    this.jsonFields.push(`'${alias}', ${expression}`);
    return this;
  }

  leftJoin(
    entity: EntityTarget<any>,
    alias: string,
    condition: string,
    params?: ObjectLiteral,
  ): this {
    this.joins.push((qb) => qb.leftJoin(entity as any, alias, condition, params));
    return this;
  }

  innerJoin(
    entity: EntityTarget<any>,
    alias: string,
    condition: string,
    params?: ObjectLiteral,
  ): this {
    this.joins.push((qb) => qb.innerJoin(entity as any, alias, condition, params));
    return this;
  }

  where(condition: string, params?: ObjectLiteral): this {
    this.whereConditions.push({ str: condition, params });
    return this;
  }

  linkToParent(childField: keyof T | string, parentField: string = 'id'): this {
    const fieldStr = String(childField);
    const childCol = fieldStr.includes('.') ? fieldStr : `${this.alias}.${fieldStr}`;
    this.whereConditions.push({
      str: `${childCol} = ${this.parentAlias}.${parentField}`,
    });
    return this;
  }

  orderBy(field: keyof T | string, order: 'ASC' | 'DESC' = 'DESC'): this {
    const fieldStr = String(field);
    const col = fieldStr.includes('.') ? fieldStr : `${this.alias}.${fieldStr}`;
    this.orderBys.push({ sort: col, order });
    return this;
  }

  limit(count: number): this {
    this.limitNum = count;
    return this;
  }

  build(sub: SelectQueryBuilder<any>): SelectQueryBuilder<any> {
    sub.from(this.entity as any, this.alias);
    this.joins.forEach((joinFn) => joinFn(sub));
    this.whereConditions.forEach(({ str, params }) => sub.andWhere(str, params));
    this.orderBys.forEach(({ sort, order }) => sub.addOrderBy(sort, order));
    if (this.limitNum) sub.limit(this.limitNum);

    const driverType = sub.connection.options.type;
    const isPostgres = driverType === 'postgres' || driverType === 'cockroachdb';

    let selection = '';
    if (isPostgres) {
      const jsonBuildObj = `json_build_object(${this.jsonFields.join(', ')})`;
      selection = `COALESCE(json_agg(${jsonBuildObj}), '[]'::json)`;
    } else {
      const jsonObject = `JSON_OBJECT(${this.jsonFields.join(', ')})`;
      selection = `COALESCE(JSON_ARRAYAGG(${jsonObject}), JSON_ARRAY())`;
    }

    return sub.select(selection);
  }
}

/**
 * ConditionalSearchBuilder
 */
export class ConditionalSearchBuilder {
  private branches: Array<{
    condition: string;
    params: ObjectLiteral;
    fields: string[];
    isExact: boolean;
  }> = [];

  constructor(
    private searchTerm: string,
    private isPostgres: boolean = false,
  ) {}

  matchCase(condition: string, params: ObjectLiteral, searchFields: string[]): this {
    this.branches.push({
      condition,
      params,
      fields: searchFields,
      isExact: false,
    });
    return this;
  }

  matchExact(condition: string, params: ObjectLiteral, searchFields: string[]): this {
    this.branches.push({
      condition,
      params,
      fields: searchFields,
      isExact: true,
    });
    return this;
  }

  build(qb: SelectQueryBuilder<any>): Brackets {
    const rawTerm = this.searchTerm.trim();
    const likeTerm = `%${rawTerm}%`;

    return new Brackets((outerQb) => {
      this.branches.forEach((branch, index) => {
        const logic = new Brackets((inner) => {
          inner.where(branch.condition, branch.params);
          inner.andWhere(
            new Brackets((s) => {
              branch.fields.forEach((f, i) => {
                const col = f.includes('.') ? f : `${qb.alias}.${f}`;
                const method = i === 0 ? 'where' : 'orWhere';

                if (branch.isExact) {
                  s[method](`${col} = :exactTerm`, { exactTerm: rawTerm });
                } else {
                  if (this.isPostgres) {
                    s[method](`${col} ILIKE :likeTerm`, { likeTerm });
                  } else {
                    s[method](`LOWER(${col}) LIKE :likeTerm`, {
                      likeTerm: likeTerm.toLowerCase(),
                    });
                  }
                }
              });
            }),
          );
        });
        index === 0 ? outerQb.where(logic) : outerQb.orWhere(logic);
      });
    });
  }
}

// --- MAIN CLASS: AdvancedQueryHelper ---
export class AdvancedQueryHelper<T extends ObjectLiteral> {
  private isPostgres: boolean;

  private constructor(public qb: SelectQueryBuilder<T>) {
    const driverType = qb.connection.options.type;
    this.isPostgres = driverType === 'postgres' || driverType === 'cockroachdb';
  }

  private readonly logger = new Logger(AdvancedQueryHelper.name, {
    timestamp: true,
  });

  static from<T extends ObjectLiteral>(
    source: Repository<T> | SelectQueryBuilder<T>,
    alias: string = 'root',
  ): AdvancedQueryHelper<T> {
    const builder = source instanceof Repository ? source.createQueryBuilder(alias) : source;
    return new AdvancedQueryHelper(builder);
  }

  private prefixCol(field: string): string {
    return field.includes('.') ? field : `${this.qb.alias}.${field}`;
  }

  debug(): this {
    this.logger.log('Driver:', this.isPostgres ? 'Postgres' : 'MySQL/Other');
    this.logger.debug('SQL:', this.qb.getSql());
    this.logger.debug('PARAMS:', this.qb.getParameters());
    return this;
  }

  select(fields: string[]): this {
    this.qb.select(fields.map((f) => this.prefixCol(f)));
    return this;
  }

  addSelect(fields: string[]): this {
    this.qb.addSelect(fields.map((f) => this.prefixCol(f)));
    return this;
  }

  // --- JOINS ---
  joinRelation(
    relation: keyof T,
    alias: string,
    condition?: { str: string; params?: ObjectLiteral },
  ): this {
    const relationStr = `${this.qb.alias}.${String(relation)}`;
    if (condition) {
      this.qb.innerJoin(relationStr, alias, condition.str, condition.params);
    } else {
      this.qb.innerJoin(relationStr, alias);
    }
    return this;
  }

  leftJoinRelation(
    relation: keyof T,
    alias: string,
    condition?: { str: string; params?: ObjectLiteral },
  ): this {
    const relationStr = `${this.qb.alias}.${String(relation)}`;
    if (condition) {
      this.qb.leftJoin(relationStr, alias, condition.str, condition.params);
    } else {
      this.qb.leftJoin(relationStr, alias);
    }
    return this;
  }

  joinEntity(
    entity: EntityTarget<any>,
    alias: string,
    condition: string,
    params?: ObjectLiteral,
  ): this {
    this.qb.innerJoin(entity as any, alias, condition, params);
    return this;
  }

  leftJoinEntity(
    entity: EntityTarget<any>,
    alias: string,
    condition: string,
    params?: ObjectLiteral,
  ): this {
    this.qb.leftJoin(entity as any, alias, condition, params);
    return this;
  }

  leftJoinAndMapOne(
    mapTo: string,
    entity: EntityTarget<any>,
    alias: string,
    condition: string,
    params?: ObjectLiteral,
  ): this {
    this.qb.leftJoinAndMapOne(this.prefixCol(mapTo), entity as any, alias, condition, params);
    return this;
  }

  leftJoinAndMapMany(
    mapTo: string,
    entity: EntityTarget<any>,
    alias: string,
    condition: string,
    params?: ObjectLiteral,
  ): this {
    this.qb.leftJoinAndMapMany(this.prefixCol(mapTo), entity as any, alias, condition, params);
    return this;
  }

  leftJoinAndSelect(
    property: string,
    alias: string,
    condition?: string,
    params?: ObjectLiteral,
  ): this {
    this.qb.leftJoinAndSelect(property, alias, condition, params);
    return this;
  }

  innerJoinAndSelect(
    property: string,
    alias: string,
    condition?: string,
    params?: ObjectLiteral,
  ): this {
    this.qb.innerJoinAndSelect(property, alias, condition, params);
    return this;
  }

  // --- SUBQUERY ---
  selectJsonArray<SubEntity extends ObjectLiteral>(
    resultAlias: string,
    entity: EntityTarget<SubEntity>,
    alias: string,
    setup: (builder: JsonSubQueryBuilder<SubEntity>) => void,
  ): this {
    const builder = new JsonSubQueryBuilder(entity, alias, this.qb.alias);
    setup(builder);

    this.qb.addSelect((subQuery) => {
      return builder.build(subQuery);
    }, resultAlias);

    return this;
  }

  mapOneWithSubQuery(config: ComplexMapConfig<T>): this {
    const { mapTo, entity, alias, conditionBuilder, extraCondition, params } = config;
    const subQueryFactory = (sq: SelectQueryBuilder<any>) => {
      return conditionBuilder(sq, this.qb.alias).getQuery();
    };

    let conditionStr = `${alias}.id IN (${subQueryFactory(this.qb.subQuery())})`;
    if (extraCondition) conditionStr += ` AND ${extraCondition}`;

    this.qb.leftJoinAndMapOne(
      this.prefixCol(String(mapTo)),
      entity as any,
      alias,
      conditionStr,
      params,
    );
    return this;
  }

  selectSubQuery(
    alias: string,
    builder: (sub: SelectQueryBuilder<any>, parentAlias: string) => SelectQueryBuilder<any>,
  ): this {
    this.qb.addSelect((sub) => builder(sub, this.qb.alias), alias);
    return this;
  }

  // --- SEARCH & FILTER ---
  search(keyword: string | undefined, fields: string[]): this {
    if (!keyword || !keyword.trim() || fields.length === 0) return this;

    const rawTerm = keyword.trim();
    const likeTerm = `%${rawTerm}%`;
    this.qb.andWhere(
      new Brackets((innerQb) => {
        fields.forEach((field, index) => {
          const col = field.includes('.') ? field : `${this.qb.alias}.${field}`;
          const method = index === 0 ? 'where' : 'orWhere';

          const paramName = `s_term_${index}_${Math.random().toString(36).substring(7)}`;

          if (this.isPostgres) {
            innerQb[method](`${col} ILIKE :${paramName}`);

            this.qb.setParameter(paramName, likeTerm);
          } else {
            innerQb[method](`LOWER(${col}) LIKE :${paramName}`);

            this.qb.setParameter(paramName, likeTerm.toLowerCase());
          }
        });
      }),
    );

    return this;
  }

  smartSearch(
    keyword: string | undefined,
    setup: (builder: ConditionalSearchBuilder) => void,
  ): this {
    if (!keyword || !keyword.trim()) return this;

    const builder = new ConditionalSearchBuilder(keyword, this.isPostgres);
    setup(builder);

    this.qb.andWhere(builder.build(this.qb));
    return this;
  }

  filter(condition: string | Partial<T>, params?: ObjectLiteral): this {
    if (typeof condition === 'string') {
      this.qb.andWhere(condition, params);
    } else {
      Object.entries(condition).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
          const field = key.includes('.') ? key : `${this.qb.alias}.${key}`;
          const paramName = `eq_${key.replace('.', '_')}_${Math.random().toString(36).substring(7)}`;
          this.qb.andWhere(`${field} = :${paramName}`, { [paramName]: value });
        }
      });
    }
    return this;
  }

  filterIn(field: keyof T | string, values: any[] | undefined): this {
    if (!values || values.length === 0) return this;
    const fieldStr = String(field);
    const col = fieldStr.includes('.') ? fieldStr : `${this.qb.alias}.${fieldStr}`;
    const paramName = `in_${fieldStr.replace('.', '_')}_${Math.random().toString(36).substring(7)}`;
    this.qb.andWhere(`${col} IN (:...${paramName})`, { [paramName]: values });
    return this;
  }

  filterRange(field: keyof T | string, from: any, to: any): this {
    const fieldStr = String(field);
    const col = fieldStr.includes('.') ? fieldStr : `${this.qb.alias}.${fieldStr}`;
    if (from !== undefined && from !== null) {
      const pName = `gte_${fieldStr.replace('.', '_')}`;
      this.qb.andWhere(`${col} >= :${pName}`, { [pName]: from });
    }
    if (to !== undefined && to !== null) {
      const pName = `lte_${fieldStr.replace('.', '_')}`;
      this.qb.andWhere(`${col} <= :${pName}`, { [pName]: to });
    }
    return this;
  }

  filterIsNull(field: keyof T | string): this {
    const fieldStr = String(field);
    const col = fieldStr.includes('.') ? fieldStr : `${this.qb.alias}.${fieldStr}`;
    this.qb.andWhere(`${col} IS NULL`);
    return this;
  }

  filterNotNull(field: keyof T | string): this {
    const fieldStr = String(field);
    const col = fieldStr.includes('.') ? fieldStr : `${this.qb.alias}.${fieldStr}`;
    this.qb.andWhere(`${col} IS NOT NULL`);
    return this;
  }

  groupBy(field: keyof T | string): this {
    this.qb.addGroupBy(this.prefixCol(String(field)));
    return this;
  }

  having(condition: string, params?: ObjectLiteral): this {
    this.qb.having(condition, params);
    return this;
  }

  // --- EXECUTION ---

  async getOne(): Promise<T | null> {
    return this.qb.getOne();
  }

  async getPaginated(options: PaginationOptions): Promise<PaginatedResult<T>> {
    const page = Math.max(1, Number(options.page) || 1);
    const limit = Number(options.limit) || 10;
    const isNoLimit = limit === 0;

    if (options.sort) {
      options.sort.split(',').forEach((s) => {
        const [f, o] = s.split(':');
        if (f) {
          const col = f.includes('.') ? f : `${this.qb.alias}.${f}`;
          this.qb.addOrderBy(col, o?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC');
        }
      });
    } else {
      if (!Object.keys(this.qb.expressionMap.orderBys).length) {
        this.qb.addOrderBy(`${this.qb.alias}.createdAt`, 'DESC');
      }
    }

    const countQuery = this.qb.clone();
    countQuery.expressionMap.selects = [];
    countQuery.expressionMap.orderBys = {};
    countQuery.select(`COUNT(DISTINCT ${this.qb.alias}.id)`, 'total');

    const countResult = await countQuery.getRawOne();
    const total = parseInt(countResult?.total || '0', 10);

    if (!isNoLimit) {
      this.qb.offset((page - 1) * limit).limit(limit);
    }

    const data = await this.qb.getMany();

    return {
      data,
      meta: {
        total,
        page,
        limit: isNoLimit ? total : limit,
        totalPages: isNoLimit || limit === 0 ? 1 : Math.ceil(total / limit),
      },
    };
  }

  getBuilder(): SelectQueryBuilder<T> {
    return this.qb;
  }
}
