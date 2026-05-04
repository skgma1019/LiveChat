# Project: 실시간 채팅 서비스

## Stack
Node.js + Express / Socket.IO / MongoDB Atlas + Mongoose / JWT + bcrypt / Render 배포

## DB Collections
- users: username, passwordHash
- rooms: roomName, roomCode, createdBy, members
- messages: roomId, senderId, text, type(text/image/video/system), createdAt

## Socket Events
- chat:send / chat:receive

## 완료된 기능
인증(JWT), 방생성/참가(코드), 실시간채팅, 파일업로드(이미지2MB/영상10MB), 방장/강퇴, 배포

## 미완성 (우선순위순)
1. 예외처리: 잘못된 방코드, 중복참가
2. 권한검증: 방장체크, 참가자검증
3. 보안: XSS, 파일검증, 토큰처리
4. 상태복구: 새로고침 시 방 복귀