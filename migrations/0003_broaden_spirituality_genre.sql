UPDATE library_titles
SET genre = REPLACE(genre, 'Mythology & Spirituality', 'Religion, Spirituality & Philosophy'),
    updated_at = CURRENT_TIMESTAMP
WHERE genre LIKE '%Mythology & Spirituality%';
