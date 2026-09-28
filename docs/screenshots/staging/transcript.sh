#!/bin/sh
# A staged Claude Code exchange for the landing-page screenshot.
printf '\033[2J\033[3J\033[H\033[?25l'
O='\033[38;5;173m'; B='\033[1m'; D='\033[2m'; G='\033[32m'; R='\033[0m'; C='\033[36m'
printf " ${O}▐▛███▜▌${R}   ${B}Claude Code${R} ${D}v2.1.283${R}\n"
printf "${O}▝▜█████▛▘${R}  ${D}Opus 5.5 · ~/work/checkout-service${R}\n"
printf "  ${O}▘▘ ▝▝${R}\n\n"
printf "${D}>${R} Put CI, deploys and test health for checkout-service on one\n"
printf "  dashboard. Keep it next to me while I work.\n\n"
printf "${G}●${R} ${B}Bash${R}(gh run list --limit 20 --json name,status,conclusion)\n"
printf "  ${D}⎿  20 runs · 1 in progress · 1 failed${R}\n\n"
printf "${G}●${R} ${B}Bash${R}(gh pr list --json number,title,reviewDecision)\n"
printf "  ${D}⎿  6 open pull requests${R}\n\n"
printf "${G}●${R} ${B}Bash${R}(npx vitest run --reporter=json --coverage)\n"
printf "  ${D}⎿  1,284 passed · 3 skipped · coverage 87.2%%${R}\n\n"
printf "${G}●${R} ${B}roer - show_ui${R} ${D}(MCP)${R}(surfaceId: \"checkout-dashboard\")\n"
printf "  ${D}⎿  Panel open beside this session${R}\n\n"
printf "${G}●${R} The dashboard is up in the panel on the right. The nightly\n"
printf "  e2e run failed on ${C}refund-flow.spec.ts${R}; the production deploy\n"
printf "  is waiting on your approval. Say the word and I'll dig into\n"
printf "  the failure while you review.\n\n"
printf "${D}────────────────────────────────────────────────────────────${R}\n"
printf "${D}>${R} \033[7m \033[0m\n"
printf "${D}────────────────────────────────────────────────────────────${R}\n"
printf "  ${D}? for shortcuts${R}\n"
exec sleep 100000
