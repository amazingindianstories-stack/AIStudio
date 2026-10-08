-- Disposable fixtures only; current PostgreSQL hierarchy/naming behavior.
BEGIN;
INSERT INTO projects(id,name,created_at,updated_at) VALUES
 ('11111111-1111-4111-8111-111111111111','First',0,0),
 ('22222222-2222-4222-8222-222222222222','Second',0,0);
INSERT INTO folders(id,project_id,parent_id,name,created_at) VALUES
 ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111',NULL,'  ＦＯＬＤＥＲ  ',0),
 ('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','33333333-3333-4333-8333-333333333333','Child',0);
COMMIT;
DO $$ BEGIN
 IF (SELECT name_normalized FROM folders WHERE id='33333333-3333-4333-8333-333333333333') <> 'folder' THEN RAISE EXCEPTION 'NFKC normalization failed'; END IF;
 BEGIN
  INSERT INTO folders(project_id,name,created_at) VALUES ('11111111-1111-4111-8111-111111111111','folder',0);
  RAISE EXCEPTION 'Duplicate normalized sibling accepted';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  UPDATE folders SET project_id='22222222-2222-4222-8222-222222222222' WHERE id='44444444-4444-4444-8444-444444444444';
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'Child scope mismatch accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  DELETE FROM folders WHERE id='33333333-3333-4333-8333-333333333333';
  RAISE EXCEPTION 'Parent deletion accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
INSERT INTO generations(id,kind,status,prompt,model,aspect_ratio,project_id,folder_id,created_at,updated_at)
VALUES ('55555555-5555-4555-8555-555555555555','image','done','fixture','fixture','1:1','11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444',0,0);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM generation_naming WHERE generation_id='55555555-5555-4555-8555-555555555555' AND namespace='folder:44444444-4444-4444-8444-444444444444' AND sequence=1) THEN RAISE EXCEPTION 'Automatic naming failed'; END IF;
 BEGIN
  UPDATE generations SET project_id='22222222-2222-4222-8222-222222222222' WHERE id='55555555-5555-4555-8555-555555555555';
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'Generation scope mismatch accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE generation_naming SET namespace='global_unsorted' WHERE generation_id='55555555-5555-4555-8555-555555555555';
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE EXCEPTION 'Naming namespace mismatch accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  UPDATE generation_naming SET sequence=0 WHERE generation_id='55555555-5555-4555-8555-555555555555';
  RAISE EXCEPTION 'Nonpositive naming sequence accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
-- Deferred constraints allow a whole scope move, including existing children.
BEGIN;
UPDATE folders SET project_id='22222222-2222-4222-8222-222222222222' WHERE id='33333333-3333-4333-8333-333333333333';
UPDATE folders SET project_id='22222222-2222-4222-8222-222222222222' WHERE id='44444444-4444-4444-8444-444444444444';
UPDATE generations SET project_id='22222222-2222-4222-8222-222222222222' WHERE id='55555555-5555-4555-8555-555555555555';
COMMIT;
UPDATE generations SET folder_id=NULL WHERE id='55555555-5555-4555-8555-555555555555';
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM generation_naming WHERE generation_id='55555555-5555-4555-8555-555555555555' AND namespace='project_unsorted:22222222-2222-4222-8222-222222222222' AND sequence=1) THEN RAISE EXCEPTION 'Move naming reassignment failed'; END IF;
END $$;
DELETE FROM generations WHERE id='55555555-5555-4555-8555-555555555555';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM generation_naming WHERE generation_id='55555555-5555-4555-8555-555555555555') THEN RAISE EXCEPTION 'Naming cascade failed'; END IF;
END $$;
