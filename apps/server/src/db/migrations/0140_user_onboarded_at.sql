-- Mark when a user finished onboarding. Null = onboarding hasn't completed
-- (either never run or interrupted). The OnboardingGate on the frontend
-- shows the flow whenever this column is null AND the user is authenticated.
--
-- Stored as a nullable timestamp so the schema is fully migratable — existing
-- accounts before this migration will re-see onboarding on their next launch,
-- which is intentional (they get a chance to pick a GitHub host and
-- confirm their repo selection on the new flow).
ALTER TABLE `user` ADD COLUMN `onboarded_at` integer;
