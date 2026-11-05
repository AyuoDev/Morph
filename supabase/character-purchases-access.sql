DO $$
DECLARE
  missing_columns text;
BEGIN
  IF to_regclass('public.character_purchases') IS NULL THEN
    RAISE EXCEPTION 'public.character_purchases does not exist';
  END IF;

  SELECT string_agg(required.column_name, ', ')
  INTO missing_columns
  FROM unnest(ARRAY[
    'id', 'user_id', 'base_mesh_id', 'character_name', 'configuration',
    'file_path', 'amount_cents', 'currency', 'status',
    'stripe_checkout_session_id', 'created_at'
  ]) AS required(column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns AS column_info
    WHERE column_info.table_schema = 'public'
      AND column_info.table_name = 'character_purchases'
      AND column_info.column_name = required.column_name
  );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'character_purchases is missing required columns: %', missing_columns;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'character-purchases') THEN
    RAISE EXCEPTION 'Storage bucket character-purchases does not exist';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_character_purchase(
  p_user_id uuid,
  p_base_mesh_id text,
  p_character_name text,
  p_configuration jsonb,
  p_file_path text,
  p_amount_cents integer
)
RETURNS TABLE (
  purchase_id uuid,
  file_path text,
  amount_cents integer,
  stripe_checkout_session_id text,
  already_purchased boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  existing public.character_purchases%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_base_mesh_id IS NULL OR p_configuration IS NULL OR p_amount_cents IS NULL OR p_amount_cents < 50 THEN
    RAISE EXCEPTION 'Invalid character purchase reservation';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_base_mesh_id || ':' || md5(p_configuration::text), 0));

  SELECT cp.*
  INTO existing
  FROM public.character_purchases AS cp
  WHERE cp.user_id = p_user_id
    AND cp.base_mesh_id = p_base_mesh_id
    AND cp.configuration = p_configuration
    AND cp.status = 'paid'
  ORDER BY cp.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT existing.id, existing.file_path, existing.amount_cents, existing.stripe_checkout_session_id, true;
    RETURN;
  END IF;

  SELECT cp.*
  INTO existing
  FROM public.character_purchases AS cp
  WHERE cp.user_id = p_user_id
    AND cp.base_mesh_id = p_base_mesh_id
    AND cp.configuration = p_configuration
    AND cp.status = 'pending'
  ORDER BY cp.created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    RETURN QUERY SELECT existing.id, existing.file_path, existing.amount_cents, existing.stripe_checkout_session_id, false;
    RETURN;
  END IF;

  INSERT INTO public.character_purchases (
    id,
    user_id,
    base_mesh_id,
    character_name,
    configuration,
    file_path,
    amount_cents,
    currency,
    status
  )
  VALUES (
    gen_random_uuid(),
    p_user_id,
    p_base_mesh_id,
    COALESCE(NULLIF(p_character_name, ''), 'Customized Character'),
    p_configuration,
    p_file_path,
    p_amount_cents,
    'usd',
    'pending'
  )
  RETURNING * INTO existing;

  RETURN QUERY SELECT existing.id, existing.file_path, existing.amount_cents, existing.stripe_checkout_session_id, false;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_character_purchase(uuid, text, text, jsonb, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_character_purchase(uuid, text, text, jsonb, text, integer) TO service_role;

ALTER TABLE public.character_purchases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.character_purchases FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.character_purchases TO authenticated;
GRANT ALL ON TABLE public.character_purchases TO service_role;

DO $$
DECLARE
  existing_policy record;
BEGIN
  FOR existing_policy IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'character_purchases'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.character_purchases', existing_policy.policyname);
  END LOOP;
END;
$$;

CREATE POLICY character_purchases_read_own
ON public.character_purchases
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

UPDATE storage.buckets
SET public = false
WHERE id = 'character-purchases';

DROP POLICY IF EXISTS character_purchases_storage_read_own ON storage.objects;
DROP POLICY IF EXISTS character_purchases_storage_insert_pending ON storage.objects;
DROP POLICY IF EXISTS character_purchases_storage_update_pending ON storage.objects;
DROP POLICY IF EXISTS character_purchases_storage_guard_select_own ON storage.objects;
DROP POLICY IF EXISTS character_purchases_storage_guard_insert_pending ON storage.objects;
DROP POLICY IF EXISTS character_purchases_storage_guard_update_pending ON storage.objects;
DROP POLICY IF EXISTS character_purchases_storage_guard_delete ON storage.objects;

CREATE POLICY character_purchases_storage_read_own
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'character-purchases'
  AND EXISTS (
    SELECT 1
    FROM public.character_purchases AS purchase
    WHERE purchase.file_path = name
      AND purchase.user_id = auth.uid()
      AND purchase.status IN ('pending', 'paid')
  )
);

CREATE POLICY character_purchases_storage_insert_pending
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'character-purchases'
  AND EXISTS (
    SELECT 1
    FROM public.character_purchases AS purchase
    WHERE purchase.file_path = name
      AND purchase.user_id = auth.uid()
      AND purchase.status = 'pending'
      AND purchase.stripe_checkout_session_id IS NULL
  )
);

CREATE POLICY character_purchases_storage_update_pending
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'character-purchases'
  AND EXISTS (
    SELECT 1
    FROM public.character_purchases AS purchase
    WHERE purchase.file_path = name
      AND purchase.user_id = auth.uid()
      AND purchase.status = 'pending'
      AND purchase.stripe_checkout_session_id IS NULL
  )
)
WITH CHECK (
  bucket_id = 'character-purchases'
  AND EXISTS (
    SELECT 1
    FROM public.character_purchases AS purchase
    WHERE purchase.file_path = name
      AND purchase.user_id = auth.uid()
      AND purchase.status = 'pending'
      AND purchase.stripe_checkout_session_id IS NULL
  )
);

CREATE POLICY character_purchases_storage_guard_select_own
ON storage.objects
AS RESTRICTIVE
FOR SELECT
TO public
USING (
  bucket_id <> 'character-purchases'
  OR EXISTS (
    SELECT 1
    FROM public.character_purchases AS purchase
    WHERE purchase.file_path = name
      AND purchase.user_id = auth.uid()
      AND purchase.status IN ('pending', 'paid')
  )
);

CREATE POLICY character_purchases_storage_guard_insert_pending
ON storage.objects
AS RESTRICTIVE
FOR INSERT
TO public
WITH CHECK (
  bucket_id <> 'character-purchases'
  OR EXISTS (
    SELECT 1
    FROM public.character_purchases AS purchase
    WHERE purchase.file_path = name
      AND purchase.user_id = auth.uid()
      AND purchase.status = 'pending'
      AND purchase.stripe_checkout_session_id IS NULL
  )
);

CREATE POLICY character_purchases_storage_guard_update_pending
ON storage.objects
AS RESTRICTIVE
FOR UPDATE
TO public
USING (
  bucket_id <> 'character-purchases'
  OR EXISTS (
    SELECT 1
    FROM public.character_purchases AS purchase
    WHERE purchase.file_path = name
      AND purchase.user_id = auth.uid()
      AND purchase.status = 'pending'
      AND purchase.stripe_checkout_session_id IS NULL
  )
)
WITH CHECK (
  bucket_id <> 'character-purchases'
  OR EXISTS (
    SELECT 1
    FROM public.character_purchases AS purchase
    WHERE purchase.file_path = name
      AND purchase.user_id = auth.uid()
      AND purchase.status = 'pending'
      AND purchase.stripe_checkout_session_id IS NULL
  )
);

CREATE POLICY character_purchases_storage_guard_delete
ON storage.objects
AS RESTRICTIVE
FOR DELETE
TO public
USING (bucket_id <> 'character-purchases');
