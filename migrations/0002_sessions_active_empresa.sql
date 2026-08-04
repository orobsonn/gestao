-- Forward: add sessions.active_empresa_id for multi-empresa session context.
-- Safe on existing D1 where 0001 already applied without this column.

ALTER TABLE sessions ADD COLUMN active_empresa_id TEXT REFERENCES empresas(id);
