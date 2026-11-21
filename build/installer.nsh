!define PB_BROWSER_CLIENT "Software\Clients\StartMenuInternet\PrivateBrowser"
!define PB_BROWSER_PROGID "Digitronics.PrivateBrowser.Url"

!macro customInstall
  WriteRegStr SHCTX "Software\RegisteredApplications" "Private Browser" "${PB_BROWSER_CLIENT}\Capabilities"
  WriteRegStr SHCTX "${PB_BROWSER_CLIENT}" "" "Private Browser"
  WriteRegStr SHCTX "${PB_BROWSER_CLIENT}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "${PB_BROWSER_CLIENT}\shell\open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\"'
  WriteRegStr SHCTX "${PB_BROWSER_CLIENT}\Capabilities" "ApplicationName" "Private Browser"
  WriteRegStr SHCTX "${PB_BROWSER_CLIENT}\Capabilities" "ApplicationDescription" "Open web links in Private Browser"
  WriteRegStr SHCTX "${PB_BROWSER_CLIENT}\Capabilities\URLAssociations" "http" "${PB_BROWSER_PROGID}"
  WriteRegStr SHCTX "${PB_BROWSER_CLIENT}\Capabilities\URLAssociations" "https" "${PB_BROWSER_PROGID}"
  WriteRegStr SHCTX "Software\Classes\${PB_BROWSER_PROGID}" "" "Private Browser web link"
  WriteRegStr SHCTX "Software\Classes\${PB_BROWSER_PROGID}" "URL Protocol" ""
  WriteRegStr SHCTX "Software\Classes\${PB_BROWSER_PROGID}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "Software\Classes\${PB_BROWSER_PROGID}\shell\open\command" "" '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    ReadRegStr $0 SHCTX "Software\Classes\${PB_BROWSER_PROGID}\shell\open\command" ""
    ${If} $0 == '$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"'
      DeleteRegValue SHCTX "Software\RegisteredApplications" "Private Browser"
      DeleteRegKey SHCTX "${PB_BROWSER_CLIENT}"
      DeleteRegKey SHCTX "Software\Classes\${PB_BROWSER_PROGID}"
    ${EndIf}
  ${EndIf}
!macroend
