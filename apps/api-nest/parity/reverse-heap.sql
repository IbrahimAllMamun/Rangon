-- Every table's rows put back in the reverse of the order they lie in.
--
-- For a replay that marks tied rows (`PARITY_TIES=mark`, parity/recording.ts):
-- a list ordered by a column that ties leaves the tied rows to the heap, and
-- on the heap a restore gives, most of them happen to come back as recorded.
-- Turned over, they come back the other way round, so one marking replay
-- finds what would otherwise show itself a case at a time, on some later day.
--
-- Same rows, same ids, same values: nothing the API could tell apart but
-- order it was never asked for. Foreign keys and triggers are held off while
-- each table is emptied and filled again (the role is the database's owner).
DO $$
DECLARE
  heap record;
BEGIN
  SET LOCAL session_replication_role = replica;
  FOR heap IN
    SELECT schemaname, tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  LOOP
    EXECUTE format('CREATE TEMP TABLE turned AS SELECT * FROM %I.%I', heap.schemaname, heap.tablename);
    EXECUTE format('DELETE FROM %I.%I', heap.schemaname, heap.tablename);
    EXECUTE format('INSERT INTO %I.%I SELECT * FROM turned ORDER BY ctid DESC', heap.schemaname, heap.tablename);
    DROP TABLE turned;
  END LOOP;
END
$$;
VACUUM ANALYZE;
