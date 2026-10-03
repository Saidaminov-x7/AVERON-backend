-- Change only the untouched legacy default; preserve administrator-selected colors.
UPDATE "ThemeSettings"
SET "primaryColor" = '#2563eb'
WHERE "primaryColor" = '#a97724';
