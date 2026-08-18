import React from 'react';
import { useAuth } from '../auth/authContext';
import { ArrowRightOnRectangleIcon } from '@heroicons/react/24/outline';

const UserProfile: React.FC = () => {
  //console.log('UserProfile component rendering...');
  
  const { user, logout, isLoading } = useAuth();
  
  //console.log('Auth state:', { user, isLoading, userExists: !!user });


  // Debug logging to see what user properties are available
  let displayName;
  let displayIdentifier;
  if (user) {
    const claims = (user.idTokenClaims || {}) as Record<string, unknown>;
    const claimName = typeof claims["name"] === "string" ? claims["name"] : undefined;
    const preferredUsername =
      typeof claims["preferred_username"] === "string" ? claims["preferred_username"] : undefined;
    const email = typeof claims["email"] === "string" ? claims["email"] : undefined;
    const oid = typeof claims["oid"] === "string" ? claims["oid"] : undefined;
    const sub = typeof claims["sub"] === "string" ? claims["sub"] : undefined;

    // console.log('User object:', user);
    // console.log('User type:', typeof user);
    // console.log('User stringified:', JSON.stringify(user, null, 2));
    displayName = user.name || claimName || user.username || preferredUsername || email || 'TBD';
    displayIdentifier = user.username || preferredUsername || email || oid || sub || 'ID not available';
  } else {
    displayName = 'TBD';
    displayIdentifier = 'ID not available';
  }

  return (
    <div className="user-profile">
      <div>
        <span className="user-name">
          {displayName}
        </span>
        {displayIdentifier !== displayName && displayIdentifier !== 'ID not available' && (
          <span className="user-identifier">
            {displayIdentifier}
          </span>
        )}
      </div>
      <button
        onClick={logout}
        disabled={isLoading}
        className="icon-button"
        aria-label="Sign out"
        title="Sign out"
      >
        <ArrowRightOnRectangleIcon />
      </button>
    </div>
  );
};

export default UserProfile;
