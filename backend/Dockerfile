FROM dunglas/frankenphp:php8.3

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer

WORKDIR /app

RUN install-php-extensions mongodb

COPY composer.json ./
RUN composer install --no-dev --no-interaction --prefer-dist

COPY . .
RUN composer dump-autoload --optimize --no-dev --no-interaction

EXPOSE 4000

CMD ["frankenphp", "run", "--config", "/app/Caddyfile"]
