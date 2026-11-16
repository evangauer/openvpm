-- Keep the invoker trigger and its existing privileges/body intact. It uses
-- only trigger records and PostgreSQL built-ins, so no schema lookup is needed.
ALTER FUNCTION public.guard_offline_field_batch() SET search_path = '';
