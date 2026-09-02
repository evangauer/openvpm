-- SOAP addendum restoration is an internal recovery operation. PostgreSQL
-- grants function execution to PUBLIC by default, and legacy Supabase roles
-- may also retain direct grants, so remove every public/API path explicitly.
REVOKE ALL ON FUNCTION public.restore_soap_note_addendum(uuid,timestamptz,uuid,uuid,uuid,text,text,uuid,text) FROM PUBLIC;

DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
		REVOKE ALL ON FUNCTION public.restore_soap_note_addendum(uuid,timestamptz,uuid,uuid,uuid,text,text,uuid,text) FROM anon;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
		REVOKE ALL ON FUNCTION public.restore_soap_note_addendum(uuid,timestamptz,uuid,uuid,uuid,text,text,uuid,text) FROM authenticated;
	END IF;
	IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openpims_app') THEN
		GRANT EXECUTE ON FUNCTION public.restore_soap_note_addendum(uuid,timestamptz,uuid,uuid,uuid,text,text,uuid,text) TO openpims_app;
	END IF;
END
$$;
