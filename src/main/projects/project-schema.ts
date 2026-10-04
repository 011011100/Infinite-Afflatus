import type { DatabaseSync } from 'node:sqlite';

/** Version-1 schema shared by live projects and portable package validation. */
export function validateProjectSchema(db: DatabaseSync): void {
  const schema = db
    .prepare(
      "SELECT name, type FROM sqlite_schema WHERE substr(name, 1, 7) <> 'sqlite_'",
    )
    .all();
  if (
    schema.length !== 2 ||
    schema.some(
      (row) =>
        row.type !== 'table' ||
        !['metadata', 'assets'].includes(String(row.name)),
    )
  )
    throw new Error('项目数据库包含不支持的表、视图或触发器');
  for (const [table, expected] of [
    [
      'metadata',
      [
        { name: 'key', pk: 1, notnull: 0 },
        { name: 'value', pk: 0, notnull: 1 },
      ],
    ],
    [
      'assets',
      [
        { name: 'id', pk: 1, notnull: 0 },
        { name: 'result_key', pk: 0, notnull: 1 },
        { name: 'payload', pk: 0, notnull: 1 },
      ],
    ],
  ] as const) {
    const columns = db.prepare(`PRAGMA table_xinfo(${table})`).all();
    if (
      columns.length !== expected.length ||
      columns.some(
        (column, index) =>
          column.name !== expected[index]?.name ||
          String(column.type).toUpperCase() !== 'TEXT' ||
          column.hidden !== 0 ||
          column.pk !== expected[index]?.pk ||
          column.notnull !== expected[index]?.notnull,
      )
    )
      throw new Error('项目数据库表结构不受支持');
    const indices = db
      .prepare(
        'SELECT name, "unique", origin, partial FROM pragma_index_list(?)',
      )
      .all(table);
    const constraints =
      table === 'metadata'
        ? [{ column: 'key', origin: 'pk' }]
        : [
            { column: 'id', origin: 'pk' },
            { column: 'result_key', origin: 'u' },
          ];
    if (
      indices.length !== constraints.length ||
      constraints.some(
        (constraint) =>
          !indices.some((index) => {
            if (
              index.unique !== 1 ||
              index.partial !== 0 ||
              index.origin !== constraint.origin
            )
              return false;
            const fields = db
              .prepare('SELECT name FROM pragma_index_info(?)')
              .all(String(index.name));
            return fields.length === 1 && fields[0]?.name === constraint.column;
          }),
      )
    )
      throw new Error('项目数据库缺少必须的主键或唯一约束');
  }
}
