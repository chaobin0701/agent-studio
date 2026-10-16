-- Up Migration
ALTER TABLE knowledge_bases ADD COLUMN retrieval_config JSONB NOT NULL DEFAULT '{}';
-- Start with the currently effective settings, not an unpublished draft.
UPDATE knowledge_bases kb SET retrieval_config = jsonb_build_object(
  'retrievalMode', COALESCE(v.config->'retrievalMode', kb.draft_config->'retrievalMode', '"fulltext"'::jsonb),
  'topK', COALESCE(v.config->'topK', kb.draft_config->'topK', '5'::jsonb),
  'lexicalThreshold', COALESCE(v.config->'lexicalThreshold', kb.draft_config->'lexicalThreshold', '0.15'::jsonb),
  'vectorThreshold', COALESCE(v.config->'vectorThreshold', kb.draft_config->'vectorThreshold', '0.65'::jsonb)
) FROM (SELECT k.id, i.config FROM knowledge_bases k LEFT JOIN knowledge_index_versions i ON i.id=k.active_index_version_id) v
WHERE v.id=kb.id;

-- Legacy FAQ becomes a downloadable Markdown document. Preserve document IDs,
-- visibility, FAQ audit rows, index chunks and immutable historical versions.
ALTER TABLE documents ADD COLUMN inline_content TEXT;
UPDATE documents d SET source_type='file', original_filename='knowledge-'||d.id||'.md',
  inline_content='# '||f.question||E'\n\n'||f.answer||
    CASE WHEN f.category='' THEN '' ELSE E'\n\n分类：'||f.category END||
    CASE WHEN f.source='' THEN '' ELSE E'\n\n来源：'||f.source END,
  parser_version='legacy-markdown-v1'
FROM faq_entries f WHERE f.document_id=d.id AND d.source_type='faq';
UPDATE documents SET extracted_text=inline_content, byte_size=octet_length(inline_content),
  sha256=encode(sha256(convert_to(inline_content,'UTF8')),'hex') WHERE inline_content IS NOT NULL;
UPDATE document_blocks b SET block_type='paragraph', content=d.inline_content, heading_path=d.title,
  source_locator=jsonb_build_object('type','markdown_lines','start',1,'end',1+length(d.inline_content)-length(replace(d.inline_content,E'\n','')))
FROM documents d WHERE d.id=b.document_id AND d.inline_content IS NOT NULL;

-- Keep each existing document's processing rules stable when defaults are edited.
UPDATE documents d SET chunk_override=jsonb_build_object(
  'chunkMode',COALESCE(k.draft_config->'chunkMode','"general"'::jsonb),
  'chunkChars',COALESCE(k.draft_config->'chunkChars','800'::jsonb),
  'overlapChars',COALESCE(k.draft_config->'overlapChars','60'::jsonb),
  'parentChars',COALESCE(k.draft_config->'parentChars','2400'::jsonb),
  'childChars',COALESCE(k.draft_config->'childChars','500'::jsonb),
  'childOverlapChars',COALESCE(k.draft_config->'childOverlapChars','50'::jsonb)
)||COALESCE(d.chunk_override,'{}'::jsonb)
FROM knowledge_bases k WHERE k.id=d.knowledge_base_id;

-- Down Migration
-- Content conversion is retained to preserve subsequent document edits.
ALTER TABLE knowledge_bases DROP COLUMN retrieval_config;
