UPDATE library_titles
SET genre = CASE
  WHEN genre IN (
    'Fiction','Romance','Historical','Regency','Mystery & Crime','Suspense & Thriller',
    'Science Fiction','Fantasy','Horror','Children','Young Adult','Comics & Graphic Novels',
    'Poetry','Biography & Memoir','History','Religion, Spirituality & Philosophy','Self-help',
    'Business','Science & Technology','Regional Literature','Non-fiction','Other'
  ) THEN genre
  WHEN LOWER(genre) LIKE 'fiction,%' THEN 'Fiction'
  WHEN LOWER(genre) LIKE '%suspense%' OR LOWER(genre) LIKE '%thriller%' THEN 'Suspense & Thriller'
  WHEN LOWER(genre) LIKE '%mystery%' OR LOWER(genre) LIKE '%crime%' OR LOWER(genre) LIKE '%detective%' THEN 'Mystery & Crime'
  WHEN LOWER(genre) LIKE '%science fiction%' OR LOWER(genre) LIKE '%sci-fi%' THEN 'Science Fiction'
  WHEN LOWER(genre) LIKE '%fantasy%' THEN 'Fantasy'
  WHEN LOWER(genre) LIKE '%horror%' THEN 'Horror'
  WHEN LOWER(genre) LIKE '%young adult%' THEN 'Young Adult'
  WHEN LOWER(genre) LIKE '%children%' OR LOWER(genre) LIKE '%juvenile%' THEN 'Children'
  WHEN LOWER(genre) LIKE '%comic%' OR LOWER(genre) LIKE '%graphic novel%' THEN 'Comics & Graphic Novels'
  WHEN LOWER(genre) LIKE '%poetry%' OR LOWER(genre) LIKE '%poem%' THEN 'Poetry'
  WHEN LOWER(genre) LIKE '%biograph%' OR LOWER(genre) LIKE '%memoir%' OR LOWER(genre) LIKE '%hemingway%' THEN 'Biography & Memoir'
  WHEN LOWER(genre) LIKE '%myth%' OR LOWER(genre) LIKE '%spiritual%' OR LOWER(genre) LIKE '%religion%'
    OR LOWER(genre) LIKE '%theolog%' OR LOWER(genre) LIKE '%philosoph%' OR LOWER(genre) LIKE '%humanism%'
    OR LOWER(genre) LIKE '%bhagavad%' OR LOWER(genre) LIKE '%bhakti%' THEN 'Religion, Spirituality & Philosophy'
  WHEN LOWER(genre) LIKE '%self-help%' OR LOWER(genre) LIKE '%self help%' OR LOWER(genre) LIKE '%advice%'
    OR LOWER(genre) LIKE '%how-to%' OR LOWER(genre) LIKE '%technique%' THEN 'Self-help'
  WHEN LOWER(genre) LIKE '%business%' OR LOWER(genre) LIKE '%econom%' OR LOWER(genre) LIKE '%finance%'
    OR LOWER(genre) LIKE '%management%' THEN 'Business'
  WHEN LOWER(genre) LIKE '%technology%' OR LOWER(genre) LIKE '%computer%' OR LOWER(genre) LIKE '%engineering%'
    OR LOWER(genre) LIKE '%science%' OR LOWER(genre) LIKE '%medicine%' OR LOWER(genre) LIKE '%medical%'
    OR LOWER(genre) LIKE '%heparin%' OR LOWER(genre) LIKE '%ayurved%' THEN 'Science & Technology'
  WHEN LOWER(genre) LIKE '%regency%' THEN 'Regency'
  WHEN LOWER(genre) LIKE '%romance%' OR LOWER(genre) LIKE '%love stor%' THEN 'Romance'
  WHEN LOWER(genre) LIKE '%historical%' THEN 'Historical'
  WHEN LOWER(genre) LIKE '%history%' OR LOWER(genre) LIKE '%social life and customs%'
    OR LOWER(genre) LIKE '%irish americans%' OR LOWER(genre) LIKE '%romans%' THEN 'History'
  WHEN LOWER(genre) LIKE '%non-fiction%' OR LOWER(genre) LIKE '%nonfiction%' THEN 'Non-fiction'
  WHEN LOWER(genre) LIKE '%fiction%' OR LOWER(genre) LIKE '%novel%' OR LOWER(genre) LIKE '%drama%'
    OR LOWER(genre) LIKE '%narrative%' OR LOWER(genre) LIKE '%famil%' THEN 'Fiction'
  ELSE 'Other'
END,
updated_at = CURRENT_TIMESTAMP;
