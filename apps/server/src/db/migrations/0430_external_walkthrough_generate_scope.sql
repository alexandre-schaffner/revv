UPDATE `external_integrations`
SET `scopes` = json_insert(`scopes`, '$[#]', 'walkthrough:generate')
WHERE json_valid(`scopes`)
  AND json_type(`scopes`) = 'array'
  AND NOT EXISTS (
    SELECT 1 FROM json_each(`external_integrations`.`scopes`) WHERE `value` = 'walkthrough:generate'
  );
