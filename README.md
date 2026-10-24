## clone project

git clone ...

## start docker

## step 1: run command:->

docker-compose build

## step 2: run command:->

docker-compose run --rm nestjs-app npm run migration:generate -- rc/databases/migrations/migrations

## step 3: run command:->

docker-compose up

################################

## access the path to use the api

http://localhost:8000

## access the path to use the document api

http://localhost:8000/api

## database operations

npm run migration:generate src/config/databases/migrations/migrations
npm run migration:run
