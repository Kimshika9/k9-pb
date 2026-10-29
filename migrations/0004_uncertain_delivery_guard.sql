-- Keep uncertain external actions locked against new operation IDs too.
-- No messages or source data are changed. Resolve uncertainty explicitly first.
DROP INDEX publications_active_source;
CREATE UNIQUE INDEX publications_active_source
 ON publications(origin_post_id,source_revision,coalesce(channel_id,''),kind)
 WHERE status IN ('preparing','sending','uncertain');
