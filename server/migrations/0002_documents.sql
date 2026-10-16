-- Up Migration

CREATE TABLE documents (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    original_filename VARCHAR(255) NOT NULL,
    storage_key VARCHAR(100) NOT NULL UNIQUE,
    sha256 CHAR(64) NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 2097152),
    uploaded_by BIGINT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
    status VARCHAR(20) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'extracted', 'failed')),
    extracted_text TEXT,
    error_message VARCHAR(300),
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX documents_created_at_idx ON documents (created_at DESC);
CREATE INDEX documents_active_status_idx ON documents (status) WHERE archived_at IS NULL;
