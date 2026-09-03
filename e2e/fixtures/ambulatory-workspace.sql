\set ON_ERROR_STOP on

-- Synthetic, disposable acceptance data. Run only after the standard seed in
-- a throwaway database dedicated to AMBULATORY_E2E=1.
DO $$
BEGIN
  IF current_database() !~ '^openvpm_ambulatory_[a-zA-Z0-9_]+$' THEN
    RAISE EXCEPTION 'Refusing ambulatory fixture on non-disposable database: %',
      current_database();
  END IF;
END
$$;

SELECT id AS practice_id
FROM practices
WHERE name = 'Neighborhood Veterinary'
  AND deleted_at IS NULL
ORDER BY created_at
LIMIT 1
\gset

SELECT id AS veterinarian_id
FROM users
WHERE practice_id = :'practice_id'
  AND email = 'sarah.chen@neighborhoodvet.example.com'
  AND deleted_at IS NULL
LIMIT 1
\gset

-- The standard demo seed deliberately randomizes Sarah's current-day schedule.
-- Neutralize only bookings that could overlap this synthetic field visit so
-- provider-conflict protection remains enabled while the acceptance run stays
-- deterministic.
UPDATE appointments
SET deleted_at = now(),
    updated_at = now()
WHERE practice_id = :'practice_id'
  AND doctor_id = :'veterinarian_id'
  AND deleted_at IS NULL
  AND status NOT IN ('cancelled', 'no_show')
  AND start_time < now() + interval '30 minutes'
  AND end_time > now();

UPDATE practices
SET settings = COALESCE(settings, '{}'::jsonb) ||
  '{"ambulatoryWorkspace":{"enabled":true,"measurementSystem":"us_customary","bodyConditionScale":5,"compactCloseout":true}}'::jsonb
WHERE id = :'practice_id';

INSERT INTO clients (
  id,
  practice_id,
  first_name,
  last_name,
  email,
  phone,
  address,
  city,
  state,
  zip
) VALUES (
  '10000000-0000-0000-0000-000000000001',
  :'practice_id',
  'Taylor',
  'Synthetic',
  'taylor.synthetic@example.test',
  '555-010-9999',
  '1 Synthetic Farm Road',
  'Testville',
  'NJ',
  '00000'
);

INSERT INTO patients (
  id,
  practice_id,
  client_id,
  name,
  species,
  breed,
  sex,
  status
) VALUES (
  '10000000-0000-0000-0000-000000000002',
  :'practice_id',
  '10000000-0000-0000-0000-000000000001',
  'Maple',
  'bovine',
  'Holstein',
  'female',
  'active'
);

INSERT INTO patient_weights (patient_id, weight_kg, recorded_by)
VALUES (
  '10000000-0000-0000-0000-000000000002',
  725.748,
  :'veterinarian_id'
);

INSERT INTO patient_allergies (
  patient_id,
  allergen,
  reaction,
  severity,
  noted_by
) VALUES (
  '10000000-0000-0000-0000-000000000002',
  'Penicillin',
  'Facial swelling',
  'severe',
  :'veterinarian_id'
);

INSERT INTO problem_list (practice_id, patient_id, description, status)
VALUES (
  :'practice_id',
  '10000000-0000-0000-0000-000000000002',
  'Chronic left hind lameness',
  'active'
);

INSERT INTO prescriptions (
  practice_id,
  patient_id,
  medication_name,
  dosage,
  frequency,
  prescribed_by,
  start_date,
  status
) VALUES (
  :'practice_id',
  '10000000-0000-0000-0000-000000000002',
  'Meloxicam',
  '15 mg',
  'Once daily',
  :'veterinarian_id',
  CURRENT_DATE,
  'active'
);

INSERT INTO vaccination_records (
  practice_id,
  patient_id,
  vaccine_name,
  administered_by,
  administered_at,
  next_due_date
) VALUES (
  :'practice_id',
  '10000000-0000-0000-0000-000000000002',
  'Bovine respiratory vaccine',
  :'veterinarian_id',
  now() - interval '6 months',
  CURRENT_DATE + 180
);
