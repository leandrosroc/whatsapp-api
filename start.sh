#!/bin/sh

mkdir -p ./dist/src
cp ./src/env.yml ./dist/src

echo "> removing dist"
rm -rf ./dist
echo
echo "> transpiling..."
npm run build

echo
echo "> Successfully build "

echo
echo "> Starting application..."
echo

node ./dist/src/main.js